import axios from 'axios'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'

dotenv.config()

const USERNAME = process.env.WP_USERNAME || ''
const PASSWORD = process.env.WP_PASSWORD || ''
const HOST = process.env.WP_HOST || ''

const POSTS_URL  = `${HOST}/wp-json/wp/v2/posts`
const MEDIA_URL  = `${HOST}/wp-json/wp/v2/media`
const TAGS_URL   = `${HOST}/wp-json/wp/v2/tags`
const CATS_URL   = `${HOST}/wp-json/wp/v2/categories`
const PAGES_DIR  = './pages'
const DELAY      = 1000

const auth = { username: USERNAME, password: PASSWORD }

// ─── 工具函数 ─────────────────────────────────────────────────

function getMimeType(filename) {
  return filename.endsWith('.jpg') || filename.endsWith('.jpeg')
    ? 'image/jpeg'
    : 'image/png'
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── HTML 解析 ────────────────────────────────────────────────

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  return m ? m[1].trim() : ''
}

function extractDescription(html) {
  const m = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)
    || html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i)
  return m ? m[1].trim() : ''
}

/** 从 HTML 中找第一张图片路径，格式如 images/xxx.jpg */
function extractFirstImage(html) {
  const m = html.match(/src="(images\/[^"]+)"/i)
  return m ? m[1] : null
}

// ─── 图片上传 ─────────────────────────────────────────────────

async function findExistingMedia(slug) {
  try {
    const res = await axios.get(`${MEDIA_URL}?slug=${encodeURIComponent(slug)}`, { auth })
    return res.data.length > 0 ? res.data[0] : null
  } catch {
    return null
  }
}

async function uploadImage(imagesDir, filename, uploadedFilename) {
  const fileData = fs.readFileSync(path.join(imagesDir, filename))
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(MEDIA_URL, fileData, {
        auth,
        headers: {
          'Content-Type': getMimeType(filename),
          'Content-Disposition': `attachment; filename="${uploadedFilename}"`,
        },
      })
      return res.data
    } catch (err) {
      if (attempt === 3) throw err
      const wait = attempt * 3000
      console.warn(`    ↻ 重试 ${attempt}/3，等待 ${wait / 1000}s... (${err.message})`)
      await sleep(wait)
    }
  }
}

async function uploadAllImages(htmlContent, imagesDir, slug) {
  const imagePaths = new Set(
    [...htmlContent.matchAll(/src="(images\/[^"]+)"/g)].map(m => m[1])
  )
  console.log(`  发现 ${imagePaths.size} 张图片，开始上传...`)

  const urlMap = {}
  for (const imgPath of imagePaths) {
    const filename = imgPath.replace('images/', '')
    const ext = path.extname(filename)
    const base = path.basename(filename, ext)
    const uploadedFilename = `${slug}-${base}${ext}`
    const mediaSlug = uploadedFilename.replace(/\.[^.]+$/, '').toLowerCase()
    try {
      const existing = await findExistingMedia(mediaSlug)
      if (existing) {
        urlMap[imgPath] = { url: existing.source_url, id: existing.id }
        console.log(`    ↩ ${filename} 已存在，跳过`)
      } else {
        const media = await uploadImage(imagesDir, filename, uploadedFilename)
        urlMap[imgPath] = { url: media.source_url, id: media.id }
        console.log(`    ✓ ${filename} → ${uploadedFilename}`)
        await sleep(DELAY)
      }
    } catch (err) {
      console.error(`    ✗ 上传失败 ${filename}:`, err.response?.data?.message || err.message)
    }
  }
  return urlMap
}

function replaceImagePaths(html, urlMap) {
  let result = html
  for (const [local, { url }] of Object.entries(urlMap)) {
    result = result.replaceAll(local, url)
  }
  return result
}

// ─── 分类 & 标签（自动创建不存在的） ───────────────────────────

async function getOrCreateTerms(names, apiUrl) {
  const ids = []
  for (const name of names) {
    try {
      // 先查找
      const search = await axios.get(`${apiUrl}?search=${encodeURIComponent(name)}`, { auth })
      const found = search.data.find(t => t.name.toLowerCase() === name.toLowerCase())
      if (found) {
        ids.push(found.id)
      } else {
        // 不存在则创建
        const created = await axios.post(apiUrl, { name }, { auth })
        ids.push(created.data.id)
        console.log(`    + 创建新术语：${name}`)
      }
    } catch (err) {
      console.warn(`    ⚠ 处理术语失败 "${name}":`, err.response?.data?.message || err.message)
    }
  }
  return ids
}

// ─── WordPress REST API ───────────────────────────────────────

async function checkExistingPost(slug) {
  try {
    const res = await axios.get(`${POSTS_URL}?slug=${slug}`, { auth })
    return res.data.length > 0 ? res.data[0] : null
  } catch (err) {
    console.error('  检查现有文章失败:', err.message)
    return null
  }
}

async function createPost(payload) {
  const res = await axios.post(POSTS_URL, payload, { auth })
  return res.data
}

async function updatePost(id, payload) {
  const res = await axios.post(`${POSTS_URL}/${id}`, payload, { auth })
  return res.data
}

// ─── 主流程 ──────────────────────────────────────────────────

async function publishPost(pageDir) {
  const slug = path.basename(pageDir)
  const htmlFile = path.join(pageDir, `${slug}.html`)
  const imagesDir = path.join(pageDir, 'images')
  const metaFile = path.join(pageDir, 'meta.json')

  if (!fs.existsSync(htmlFile)) {
    console.warn(`  跳过：未找到 ${htmlFile}`)
    return null
  }

  // 读取可选的 meta.json
  let meta = {}
  if (fs.existsSync(metaFile)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
      console.log(`  读取 meta.json`)
    } catch {
      console.warn(`  ⚠ meta.json 解析失败，已忽略`)
    }
  }

  const rawHtml = fs.readFileSync(htmlFile, 'utf-8')

  // 上传所有图片
  const urlMap = fs.existsSync(imagesDir)
    ? await uploadAllImages(rawHtml, imagesDir, slug)
    : {}
  console.log(`  图片上传完成，共 ${Object.keys(urlMap).length} 张`)

  const html = replaceImagePaths(rawHtml, urlMap)
  const content = `<!-- wp:html -->\n${html}\n<!-- /wp:html -->`

  // 基础信息：优先用 meta.json，否则从 HTML 提取
  const title   = meta.title   || extractTitle(html)   || slug
  const excerpt = meta.excerpt || extractDescription(html) || ''
  console.log(`  标题：${title}`)
  if (excerpt) console.log(`  摘要：${excerpt.slice(0, 60)}...`)

  // 特色图片
  let featuredMediaId = undefined
  const featuredImagePath = meta.featured_image  // 如 "images/banner.jpg"
    || extractFirstImage(rawHtml)
  if (featuredImagePath) {
    const mapped = urlMap[featuredImagePath]
    if (mapped) {
      featuredMediaId = mapped.id
      console.log(`  特色图片 ID：${featuredMediaId}`)
    } else {
      console.warn(`  ⚠ 特色图片未上传成功：${featuredImagePath}`)
    }
  }

  // 分类 & 标签
  const categoryIds = meta.categories?.length
    ? await getOrCreateTerms(meta.categories, CATS_URL)
    : []
  const tagIds = meta.tags?.length
    ? await getOrCreateTerms(meta.tags, TAGS_URL)
    : []

  // 组装发布 payload
  const payload = {
    title,
    slug,
    content: { raw: content },
    excerpt: { raw: excerpt },
    status: meta.status || 'publish',
    template: 'template-full-html.php',
    ...(featuredMediaId !== undefined && { featured_media: featuredMediaId }),
    ...(categoryIds.length  && { categories: categoryIds }),
    ...(tagIds.length       && { tags: tagIds }),
    ...(meta.date           && { date: meta.date }),        // ISO 8601: 2024-05-09T10:00:00
    ...(meta.author_id      && { author: meta.author_id }), // 作者 ID
    ...(meta.comment_status && { comment_status: meta.comment_status }), // open / closed
  }

  // 创建或更新
  const existing = await checkExistingPost(slug)
  let result
  if (existing) {
    console.log(`  发现已有文章（ID: ${existing.id}），正在更新...`)
    result = await updatePost(existing.id, payload)
    console.log(`  ✓ 更新成功：${result.link}`)
  } else {
    console.log('  正在创建新文章...')
    result = await createPost(payload)
    console.log(`  ✓ 创建成功：${result.link}`)
  }

  return result
}

async function run() {
  console.log('=== WordPress 文章发布工具 ===\n')

  if (!HOST || !USERNAME || !PASSWORD) {
    console.error('错误：请检查 .env 文件中的 WP_HOST、WP_USERNAME、WP_PASSWORD')
    process.exit(1)
  }

  const entries = fs.readdirSync(PAGES_DIR, { withFileTypes: true })
  const pageDirs = entries
    .filter(e => e.isDirectory())
    .map(e => path.join(PAGES_DIR, e.name))

  if (pageDirs.length === 0) {
    console.log('pages/ 目录下没有找到任何文件夹')
    return
  }

  console.log(`找到 ${pageDirs.length} 个目录：${pageDirs.map(d => path.basename(d)).join(', ')}\n`)

  let success = 0
  let errors = 0

  for (const pageDir of pageDirs) {
    const slug = path.basename(pageDir)
    console.log(`── 处理文章：${slug}`)
    try {
      await publishPost(pageDir)
      success++
    } catch (err) {
      console.error(`  ✗ 失败:`, err.response?.data?.message || err.message)
      errors++
    }
    console.log()
  }

  console.log(`=== 完成：成功 ${success}，失败 ${errors} ===`)
}

run().catch(err => {
  console.error('运行出错:', err.response?.data || err.message)
  process.exit(1)
})

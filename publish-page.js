import axios from 'axios'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'

dotenv.config()

const USERNAME = process.env.WP_USERNAME || ''
const PASSWORD = process.env.WP_PASSWORD || ''
const HOST = process.env.WP_HOST || ''

const PAGES_URL = `${HOST}/wp-json/wp/v2/pages`
const MEDIA_URL = `${HOST}/wp-json/wp/v2/media`
const PAGES_DIR = './pages'
const DELAY = 1000

const auth = { username: USERNAME, password: PASSWORD }

// ─── 图片上传 ────────────────────────────────────────────────

function getMimeType(filename) {
  return filename.endsWith('.jpg') || filename.endsWith('.jpeg')
    ? 'image/jpeg'
    : 'image/png'
}

async function findExistingMedia(mediaSlug) {
  try {
    const res = await axios.get(`${MEDIA_URL}?slug=${encodeURIComponent(mediaSlug)}`, { auth })
    return res.data.length > 0 ? res.data[0] : null
  } catch {
    return null
  }
}

async function uploadImage(imagesDir, filename, uploadedFilename) {
  const fileData = fs.readFileSync(path.join(imagesDir, filename))

  // 上传失败最多重试 3 次，间隔递增
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(MEDIA_URL, fileData, {
        auth,
        headers: {
          'Content-Type': getMimeType(filename),
          'Content-Disposition': `attachment; filename="${uploadedFilename}"`,
        },
      })
      return res.data.source_url
    } catch (err) {
      if (attempt === 3) throw err
      const wait = attempt * 3000
      console.warn(`    ↻ 重试 ${attempt}/3，等待 ${wait / 1000}s... (${err.message})`)
      await new Promise(r => setTimeout(r, wait))
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
    try {
      const existing = await findExistingMedia(uploadedFilename.replace(/\.[^.]+$/, '').toLowerCase())
      if (existing) {
        urlMap[imgPath] = existing.source_url
        console.log(`    ↩ ${filename} 已存在，跳过`)
      } else {
        const wpUrl = await uploadImage(imagesDir, filename, uploadedFilename)
        urlMap[imgPath] = wpUrl
        console.log(`    ✓ ${filename} → ${uploadedFilename}`)
        await new Promise(r => setTimeout(r, DELAY))
      }
    } catch (err) {
      console.error(`    ✗ 上传失败 ${filename}:`, err.response?.data?.message || err.message)
    }
  }

  return urlMap
}

// ─── HTML 处理 ───────────────────────────────────────────────

function replaceImagePaths(html, urlMap) {
  let result = html
  for (const [local, wpUrl] of Object.entries(urlMap)) {
    result = result.replaceAll(local, wpUrl)
  }
  return result
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  return m ? m[1].trim() : ''
}

// ─── WordPress API ───────────────────────────────────────────

async function checkExistingPage(slug) {
  try {
    const res = await axios.get(`${PAGES_URL}?slug=${slug}`, { auth })
    return res.data.length > 0 ? res.data[0] : null
  } catch (err) {
    console.error('  检查现有页面失败:', err.message)
    return null
  }
}

async function createPage(slug, title, content) {
  const res = await axios.post(
    PAGES_URL,
    { title, slug, content: { raw: content }, template: 'template-full-html.php', status: 'publish' },
    { auth }
  )
  return res.data
}

async function updatePage(id, title, content) {
  const res = await axios.post(
    `${PAGES_URL}/${id}`,
    { title, content: { raw: content }, template: 'template-full-html.php', status: 'publish' },
    { auth }
  )
  return res.data
}

// ─── 主流程 ──────────────────────────────────────────────────

async function publishPage(pageDir) {
  const slug = path.basename(pageDir)
  const htmlFile = path.join(pageDir, `${slug}.html`)
  const imagesDir = path.join(pageDir, 'images')

  if (!fs.existsSync(htmlFile)) {
    console.warn(`  跳过：未找到 ${htmlFile}`)
    return null
  }

  const rawHtml = fs.readFileSync(htmlFile, 'utf-8')

  const urlMap = fs.existsSync(imagesDir)
    ? await uploadAllImages(rawHtml, imagesDir, slug)
    : {}
  console.log(`  图片上传完成，共 ${Object.keys(urlMap).length} 张`)

  const html = replaceImagePaths(rawHtml, urlMap)
  // 用 Gutenberg Custom HTML block 包裹，与手动放 Custom HTML 效果完全一致
  const content = `<!-- wp:html -->\n${html}\n<!-- /wp:html -->`
  const title = extractTitle(html) || slug
  console.log(`  标题：${title}`)

  const existing = await checkExistingPage(slug)
  let result
  if (existing) {
    console.log(`  发现已有页面（ID: ${existing.id}），正在更新...`)
    result = await updatePage(existing.id, title, content)
    console.log(`  ✓ 更新成功：${result.link}`)
  } else {
    console.log('  正在创建新页面...')
    result = await createPage(slug, title, content)
    console.log(`  ✓ 创建成功：${result.link}`)
  }

  return result
}

async function run() {
  console.log('=== WordPress 页面发布工具 ===\n')

  if (!HOST || !USERNAME || !PASSWORD) {
    console.error('错误：请检查 .env 文件中的 WP_HOST、WP_USERNAME、WP_PASSWORD')
    process.exit(1)
  }

  const entries = fs.readdirSync(PAGES_DIR, { withFileTypes: true })
  const pageDirs = entries
    .filter(e => e.isDirectory())
    .map(e => path.join(PAGES_DIR, e.name))

  if (pageDirs.length === 0) {
    console.log('pages/ 目录下没有找到任何页面文件夹')
    return
  }

  console.log(`找到 ${pageDirs.length} 个页面：${pageDirs.map(d => path.basename(d)).join(', ')}\n`)

  let success = 0
  let errors = 0

  for (const pageDir of pageDirs) {
    const slug = path.basename(pageDir)
    console.log(`── 处理页面：${slug}`)
    try {
      await publishPage(pageDir)
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

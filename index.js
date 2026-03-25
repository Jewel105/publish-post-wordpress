import axios from 'axios'
import { load } from 'cheerio'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'

// Load environment variables from .env file
dotenv.config()

// WordPress configuration
const WP_URL = process.env.WP_URL || ''
const USERNAME = process.env.WP_USERNAME || ''
const PASSWORD = process.env.WP_PASSWORD || ''
const LOGO = process.env.WP_LOGO
const HOST = process.env.WP_HOST

console.log('WP_URL:', WP_URL)
console.log('USERNAME:', USERNAME)
console.log('PASSWORD:', PASSWORD)
// HTML文件目录
const dir = './htmls'

// Rate limiting delay (in milliseconds)
const DELAY_BETWEEN_REQUESTS = 1000

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
}

async function checkExistingPost(title) {
  try {
    const res = await axios.get(`${WP_URL}?search=${encodeURIComponent(title)}`, {
      auth: {
        username: USERNAME,
        password: PASSWORD,
      },
    })
    console.log(`是否已有文章：${res.data.length > 0 ? '有' : '无'}`)
    // Check if any returned posts match the title exactly
    // const matchingPosts = res.data.filter(post => {
    //   return post.slug === slugify(title)
    // })
    const matchingPosts = res.data
    console.log(`匹配文章：${matchingPosts.length > 0 ? '有' : '无'}`)
    return matchingPosts.length > 0 ? matchingPosts[0] : null
  } catch (error) {
    console.error(`Error checking for existing post "${title}":`, error.message)
    return null
  }
}

async function updatePost(id, title, content) {
  try {
    const res = await axios.post(
      `${WP_URL}/${id}`,
      {
        title,
        content,
        categories: [280],
        status: 'publish',
      },
      {
        auth: {
          username: USERNAME,
          password: PASSWORD,
        },
      },
    )
    console.log('更新成功:', res.data.link)
    return res.data
  } catch (error) {
    console.error(`Failed to update post ${id}:`, error.message)
    throw error
  }
}

async function createPost(title, content) {
  try {
    const res = await axios.post(
      WP_URL,
      {
        title,
        content,
        categories: [280],
        status: 'publish',
      },
      {
        auth: {
          username: USERNAME,
          password: PASSWORD,
        },
      },
    )
    console.log('发布成功:', res.data.link)
    return res.data
  } catch (error) {
    console.error(`Failed to create post "${title}":`, error.message)
    throw error
  }
}

function parseHTML(html) {
  const $ = load(html)
  const articles = []

  // 1. 提取全局样式
  let globalCss = $('style').html() || ''
  if (globalCss) {
    globalCss = globalCss.replace(/\*[\s\S]*?\{[\s\S]*?\}/, '') // 移除全局重置
  }

  // 2. 预清理：移除面包屑、脚本、样式表链接等
  $("script, link[rel='stylesheet'], .bc, nav[aria-label='breadcrumb']").remove()

  const h1Elements = $('h1')

  if (h1Elements.length === 0) {
    console.warn('未发现 H1 标签，跳过该文件')
    return []
  }

  h1Elements.each((index, el) => {
    const currentH1 = $(el)
    const title = currentH1.text().trim()

    // 获取当前 H1 到下一个 H1 之间的所有内容
    let bodyContent = ''
    const nodes = currentH1.nextUntil('h1')

    nodes.each((i, node) => {
      bodyContent += $.html(node)
    })

    // 如果 H1 后面完全没内容（可能是误触或空标签），视情况决定是否跳过
    if (!bodyContent.trim()) {
      console.log(`标题 "${title}" 下无内容，已跳过`)
      return
    }
    const currentTime = new Date().toISOString()

    // 3. 自动注入本周最紧急的 Article Schema
    const schemaData = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: title,
      datePublished: currentTime,
      dateModified: currentTime,
      author: {
        '@type': 'Organization',
        name: 'Futurum Academy',
      },
      publisher: {
        '@type': 'Organization',
        name: 'Futurum Academy',
        url: HOST,
        logo: LOGO,
      },
    }

    const finalContent = `
<script type="application/ld+json">
${JSON.stringify(schemaData, null, 2)}
</script>
<style>
  ${globalCss}
</style>
<div class="custom-html-wrapper">
  ${bodyContent}
</div>
    `
    articles.push({ title, content: finalContent })
  })

  return articles
}

async function run() {
  const files = fs.readdirSync(dir)
  let successCount = 0
  let skipCount = 0
  let errorCount = 0

  console.log(`Found ${files.length} files to process...`)

  for (const file of files) {
    if (!file.endsWith('.html')) continue

    const filePath = path.join(dir, file)
    const html = fs.readFileSync(filePath, 'utf-8')

    const articles = parseHTML(html)

    for (const article of articles) {
      try {
        const existingPost = await checkExistingPost(article.title)

        if (existingPost) {
          console.log(`更新文章: ${article.title}`)
          await updatePost(existingPost.id, article.title, article.content)
          skipCount++
        } else {
          console.log(`创建新文章: ${article.title}`)
          await createPost(article.title, article.content)
          successCount++
        }

        // 频率限制，保护 SiteGround 服务器不被 508 (Resource Limit Reached)
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_REQUESTS))
      } catch (err) {
        console.error(`处理文章 [${article.title}] 失败:`, err.message)
        errorCount++
      }
    }
  }

  // Summary report
  console.log('\n=== Processing Complete ===')
  console.log(`Successfully created: ${successCount} posts`)
  console.log(`Update (duplicates): ${skipCount} posts`)
  console.log(`Errors: ${errorCount} posts`)
  console.log(`Total processed: ${successCount + skipCount + errorCount} files`)
}

run()

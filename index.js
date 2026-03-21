import axios from "axios";
import { load } from 'cheerio';
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Load environment variables from .env file
dotenv.config();

// WordPress configuration
const WP_URL = process.env.WP_URL || "";
const USERNAME = process.env.WP_USERNAME || "";
const PASSWORD = process.env.WP_PASSWORD || "";


console.log("WP_URL:", WP_URL);
console.log("USERNAME:", USERNAME);
console.log("PASSWORD:", PASSWORD);
// HTML文件目录
const dir = "./htmls";

// Rate limiting delay (in milliseconds)
const DELAY_BETWEEN_REQUESTS = 1000;

async function checkExistingPost(title) {
  try {
    const res = await axios.get(`${WP_URL}?search=${encodeURIComponent(title)}`, {
      auth: {
        username: USERNAME,
        password: PASSWORD,
      },
    });
    
    // Check if any returned posts match the title exactly
    const matchingPosts = res.data.filter(post => 
      post.title.rendered.trim() === title.trim()
    );
    
    return matchingPosts.length > 0 ? matchingPosts[0] : null;
  } catch (error) {
    console.error(`Error checking for existing post "${title}":`, error.message);
    return null;
  }
}

async function updatePost(id, title, content) {
  try {
    const res = await axios.post(
      `${WP_URL}/${id}`,
      {
        title,
        content,
        categories:[280],
        status: "publish",
      },
      {
        auth: {
          username: USERNAME,
          password: PASSWORD,
        },
      }
    );
    console.log("更新成功:", res.data.link);
    return res.data;
  } catch (error) {
    console.error(`Failed to update post ${id}:`, error.message);
    throw error;
  }
}

async function createPost(title, content) {
  try {
    const res = await axios.post(
      WP_URL,
      {
        title,
        content,
        categories:[280],
        status: "publish",
      },
      {
        auth: {
          username: USERNAME,
          password: PASSWORD,
        },
      }
    );
    console.log("发布成功:", res.data.link);
    return res.data;
  } catch (error) {
    console.error(`Failed to create post "${title}":`, error.message);
    throw error;
  }
}

function parseHTML(html) {
  const $ = load(html);
  
  // 1. 获取标题
  const title = $("h1").first().text().trim();
  $("script, link[rel='stylesheet'], h1, .bc").remove();

  // 2. 提取并优化 CSS
  let css = $("style").html();
  // 移除危险的全局重置，防止破坏 WP 导航栏和页脚
  css = css.replace(/\*[\s\S]*?\{[\s\S]*?\}/, ""); 
  
  // 3. 提取主体内容
  const bodyContent = $("div.w").length>0? $("div.w").first() : $("body").html();

  // 4. 组合成一个“安全包”
  // 使用特殊的类名包裹，确保样式隔离
  const finalContent = `
    <style>
      /* 这里的 CSS 只会在当前页面加载 */
      ${css}
    </style>
    <div class="custom-html-wrapper">
      ${bodyContent}
    </div>
  `;

  return { title, content: finalContent };
}

async function run() {
  const files = fs.readdirSync(dir);
  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  console.log(`Found ${files.length} files to process...`);

  for (const file of files) {
    if (!file.endsWith(".html")) continue;

    const filePath = path.join(dir, file);
    let html = fs.readFileSync(filePath, "utf-8");

    const { title, content } = parseHTML(html);

    // Skip if title is empty
    if (!title || title.trim() === "") {
      console.log(`Skipping ${file}: No title found`);
      skipCount++;
      continue;
    }

    try {
      // Check if post already exists
      const existingPost = await checkExistingPost(title);
      
      if (existingPost) {
        console.log(`Skipping "${title}": Post already exists (ID: ${existingPost.id})`);
        skipCount++;
      } else {
        // Create new post
        await createPost(title, content);
        successCount++;
      }
    } catch (error) {
      console.error(`Failed to process ${file}:`, error.message);
      errorCount++;
    }

    // Rate limiting - delay between requests
    if (file !== files[files.length - 1]) { // No delay after the last file
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
    }
  }

  // Summary report
  console.log("\n=== Processing Complete ===");
  console.log(`Successfully created: ${successCount} posts`);
  console.log(`Skipped (duplicates): ${skipCount} posts`);
  console.log(`Errors: ${errorCount} posts`);
  console.log(`Total processed: ${files.length} files`);
}

run();
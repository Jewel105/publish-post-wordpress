# WordPress 配置指南（SiteGround）

## 代码需要的 WordPress 功能

`publish-page.js` 使用以下 WordPress REST API：
- `POST /wp-json/wp/v2/pages` — 创建/更新页面
- `POST /wp-json/wp/v2/media` — 上传图片
- 认证方式：Basic Auth（用户名 + Application Password）
- 自定义页面模板：`template-full-html.php`

---

## 第一步：生成 Application Password

> WordPress 5.6+ 内置此功能，不要用你的管理员登录密码。

1. 登录 WordPress 后台 → **用户** → **个人资料**
2. 滚动到底部找到 **应用程序密码（Application Passwords）**
3. 在"新密码名称"输入框填写一个名称（如 `publish-script`）
4. 点击 **添加新应用程序密码**
5. 复制生成的密码（格式类似 `xxxx xxxx xxxx xxxx xxxx xxxx`，含空格也没关系）

---

## 第二步：配置 .env 文件

```bash
# 复制示例文件
cp .env.example .env
```

编辑 `.env`，填入以下内容：

```env
WP_HOST=https://your-domain.com
WP_USERNAME=your_wp_admin_username
WP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
```

- `WP_HOST`：你的网站根域名，**不带**末尾斜杠
- `WP_USERNAME`：WordPress 管理员用户名（不是邮箱）
- `WP_PASSWORD`：上一步生成的 Application Password

---

## 第三步：创建自定义页面模板

代码指定了模板 `template-full-html.php`，必须在当前主题中创建此文件，否则页面会使用默认模板。

**在 SiteGround 上操作：**

1. 登录 SiteGround 的 **Site Tools** → **WordPress** → **File Manager**
   或者用 **cPanel → File Manager**
2. 进入路径：`public_html/wp-content/themes/你的当前主题名/`
3. 新建文件 `template-full-html.php`，内容如下：

```php
<?php
/*
 * Template Name: Full HTML Page
 * Template Post Type: page
 */
defined('ABSPATH') || exit;

// 直接输出页面内容（完整 HTML），完全绕过主题的 header/footer
$post = get_queried_object();
if ($post) {
    echo $post->post_content;
    exit;
}
```

> 如果你希望页面完全独立（没有主题的任何 CSS/JS），可以改成：

```php
<?php
/**
 * Template Name: Full HTML
 * Template Post Type: page
 */
while ( have_posts() ) :
    the_post();
    echo get_the_content();
endwhile;
```

4. 保存文件后，在 WordPress 后台 → **页面** 中，编辑任意一个页面，右侧"页面属性"下能看到"模板"下拉框出现 **Full HTML** 选项，说明配置成功。

---

## 第四步：SiteGround 安全设置检查

SiteGround 默认开启多项安全功能，可能拦截 REST API 请求。

### 4.1 SG Security 插件

1. 后台 → **SG Security** → **Site Security**
2. 检查以下选项是否影响 API：
   - **Disable REST API for guests**（禁止未登录用户访问 REST API）
     - 脚本使用 Application Password 认证，理论上不受影响，但如果遇到 401 错误可临时关闭测试

### 4.2 HTTP Basic Auth（如果 REST API 返回 401）

SiteGround 的某些配置可能屏蔽 Basic Auth header。如果遇到认证失败，在主题根目录或网站根目录的 `.htaccess` 中添加：

```apache
# 允许 Authorization header 传递给 PHP
RewriteCond %{HTTP:Authorization} ^(.*)
RewriteRule ^(.*) - [E=HTTP_AUTHORIZATION:%1]
```

或在网站根目录的 `.htaccess` 中（`# BEGIN WordPress` 之前）添加：

```apache
SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1
```

### 4.3 SG Optimizer（缓存）

上传新图片或更新页面后，缓存可能让你看不到最新内容。

1. 后台 → **SG Optimizer** → **Supercache**
2. 点击 **Flush Cache** 清除缓存

---

## 第五步：验证 REST API 是否可用

在浏览器访问：

```
https://your-domain.com/wp-json/wp/v2/pages
```

- 返回 JSON 数组 → REST API 正常
- 返回 404 → 需要在 **设置 → 固定链接** 中重新保存（选任意一个固定链接格式，点保存）
- 返回 403 → 检查 SG Security 设置

---

## 目录结构要求

脚本读取 `./pages/` 目录，结构如下：

```
pages/
├── page-slug-1/
│   ├── page-slug-1.html   ← 文件名必须与目录名一致
│   └── images/
│       ├── banner.jpg
│       └── icon.png
└── page-slug-2/
    └── page-slug-2.html
```

- HTML 文件名必须与文件夹名完全一致
- 图片引用路径格式：`src="images/filename.jpg"`
- 图片上传到 WordPress 媒体库后，文件名会自动加上 slug 前缀（如 `page-slug-1-banner.jpg`）

---

## 常见错误排查

| 错误 | 原因 | 解决 |
|------|------|------|
| `401 Unauthorized` | 密码错误或 Basic Auth 被拦截 | 检查 `.env` 密码；添加 `.htaccess` 规则 |
| `403 Forbidden` | REST API 被安全插件禁用 | 检查 SG Security 设置 |
| `404 Not Found` | REST API 路由未注册 | 重新保存固定链接 |
| 模板不生效 | `template-full-html.php` 未创建 | 按第三步创建模板文件 |
| 图片重复上传 | slug 检索名称不匹配 | 正常现象，脚本会跳过已存在的图片 |

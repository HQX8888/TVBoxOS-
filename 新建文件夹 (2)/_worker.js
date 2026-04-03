import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand
} from "@aws-sdk/client-s3"
import { ZipWriter, BlobWriter } from "@zip.js/zip.js"

// ================= 配置 =================
const S3_CONFIG = {
  endpoint: "https://s3.hi168.com",
  region: "us-east-1",
  credentials: {
    accessKeyId: "D1AASIIKMSR8GXRD5EQM",
    secretAccessKey: "WltIDXSaMbyl8ILAaWJTsPx9Cb8zFcPYA6kymMvr"
  },
  bucket: "CF网盘",
  forcePathStyle: true
}

// 登录账号（可以修改）
const USER = "admin"
const PASS = "123456"

const s3Client = new S3Client(S3_CONFIG)
const shares = new Map()
const chunkMap = new Map()
const encryptMap = new Map()

// ================= 工具函数 =================
function checkAuth(request) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) return null
    const token = authHeader.slice(7)
    const [user, pass] = atob(token).split(":")
    return (user === USER && pass === PASS) ? { user, isAdmin: true } : null
  } catch { return null }
}

function generateToken(user, pass) {
  return btoa(`${user}:${pass}`)
}

// ================= 主入口 =================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname

    // 1. 首页返回 index.html
    if (path === "/" || path === "/index.html") {
      const htmlResponse = await fetch(new URL("./index.html", import.meta.url))
      return new Response(htmlResponse.body, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      })
    }

    // 2. 公开接口：文件直链
    if (path.startsWith("/api/file/")) {
      try {
        const obj = await s3Client.send(new GetObjectCommand({
          Bucket: S3_CONFIG.bucket,
          Key: decodeURIComponent(path.slice(10))
        }))
        return new Response(obj.Body)
      } catch { return new Response("Not found", { status: 404 }) }
    }

    // 3. 公开接口：分享访问
    if (path.startsWith("/api/share/access/")) {
      const share = shares.get(path.split("/")[4])
      if (!share || share.expireAt < Date.now()) return new Response("Expired", { status: 404 })
      const inputPwd = url.searchParams.get("pwd") || ""
      if (share.password && inputPwd !== share.password) return new Response("Forbidden", { status: 403 })
      const obj = await s3Client.send(new GetObjectCommand({ Bucket: S3_CONFIG.bucket, Key: share.key }))
      return new Response(obj.Body)
    }

    // 4. 登录接口（核心修复）
    if (path === "/api/login" && request.method === "POST") {
      try {
        const { user, pass } = await request.json()
        if (user === USER && pass === PASS) {
          return Response.json({
            ok: true,
            token: generateToken(USER, PASS),
            isAdmin: true
          })
        } else {
          return Response.json({ ok: false })
        }
      } catch (e) {
        return new Response("Error", { status: 500 })
      }
    }

    // 鉴权
    const userInfo = checkAuth(request)
    if (!userInfo) return new Response("Unauthorized", { status: 401 })

    // 5. 文件列表
    if (path === "/api/list") {
      try {
        const list = await s3Client.send(new ListObjectsV2Command({ Bucket: S3_CONFIG.bucket }))
        const items = (list.Contents || []).map(o => ({
          key: o.Key,
          name: o.Key.endsWith("/") ? o.Key.split("/").filter(Boolean).pop() || o.Key : o.Key.split("/").pop(),
          type: o.Key.endsWith("/") ? "folder" : "file",
          size: o.Size
        }))
        return Response.json(items)
      } catch { return new Response("Error", { status: 500 }) }
    }

    // 6. 分片上传：检查
    if (path === "/api/check-chunk") {
      const key = url.searchParams.get("fileName") + "-" + url.searchParams.get("total")
      return Response.json(chunkMap.get(key) || [])
    }

    // 7. 分片上传：上传
    if (path === "/api/upload-chunk") {
      const fd = await request.formData()
      const chunk = fd.get("chunk")
      const index = parseInt(fd.get("index"))
      const total = parseInt(fd.get("total"))
      const fileName = fd.get("fileName")
      const key = `${fileName}-${total}`
      if (!chunkMap.has(key)) chunkMap.set(key, [])
      chunkMap.get(key).push(index)
      chunkMap.set(`${key}-${index}`, await chunk.arrayBuffer())
      return new Response("ok")
    }

    // 8. 分片上传：合并
    if (path === "/api/merge-chunk") {
      const { fileName, totalChunks } = await request.json()
      const key = `${fileName}-${totalChunks}`
      const chunks = []
      for (let i = 0; i < totalChunks; i++) {
        const c = chunkMap.get(`${key}-${i}`)
        if (!c) return new Response("Missing chunk", { status: 400 })
        chunks.push(c)
      }
      const fullBuffer = new Uint8Array(chunks.reduce((a, b) => a + b.byteLength, 0))
      let offset = 0
      for (const c of chunks) {
        fullBuffer.set(new Uint8Array(c), offset)
        offset += c.byteLength
      }
      await s3Client.send(new PutObjectCommand({ Bucket: S3_CONFIG.bucket, Key: fileName, Body: fullBuffer }))
      for (let i = 0; i < totalChunks; i++) chunkMap.delete(`${key}-${i}`)
      chunkMap.delete(key)
      return new Response("ok")
    }

    // 9. 新建文件夹
    if (path === "/api/mkdir") {
      const { name } = await request.json()
      await s3Client.send(new PutObjectCommand({ Bucket: S3_CONFIG.bucket, Key: name + "/", Body: "" }))
      return new Response("ok")
    }

    // 10. 文件读写
    if (path.startsWith("/api/file/")) {
      const key = decodeURIComponent(path.slice(10))
      if (request.method === "PUT") {
        const body = await request.text()
        await s3Client.send(new PutObjectCommand({ Bucket: S3_CONFIG.bucket, Key: key, Body: body }))
        return new Response("ok")
      }
      const obj = await s3Client.send(new GetObjectCommand({ Bucket: S3_CONFIG.bucket, Key: key }))
      return new Response(obj.Body)
    }

    // 11. 重命名
    if (path === "/api/rename") {
      const { key, newName } = await request.json()
      await s3Client.send(new CopyObjectCommand({ Bucket: S3_CONFIG.bucket, Key: newName, CopySource: `${S3_CONFIG.bucket}/${key}` }))
      await s3Client.send(new DeleteObjectCommand({ Bucket: S3_CONFIG.bucket, Key: key }))
      return new Response("ok")
    }

    // 12. 删除
    if (path === "/api/delete") {
      const { key } = await request.json()
      await s3Client.send(new DeleteObjectCommand({ Bucket: S3_CONFIG.bucket, Key: key }))
      return new Response("ok")
    }

    // 13. 打包
    if (path === "/api/zip") {
      const { keys } = await request.json()
      const zip = new ZipWriter(new BlobWriter("application/zip"))
      for (const k of keys) {
        try {
          const obj = await s3Client.send(new GetObjectCommand({ Bucket: S3_CONFIG.bucket, Key: k }))
          await zip.add(k.split("/").pop(), new Uint8Array(await obj.Body.arrayBuffer()))
        } catch {}
      }
      return new Response(await zip.close(), { headers: { "Content-Type": "application/zip" } })
    }

    // 14. 分享
    if (path === "/api/share") {
      const { key, password, expireHours } = await request.json()
      const id = Math.random().toString(36).slice(2)
      shares.set(id, { key, password, expireAt: Date.now() + expireHours * 3600 * 1000 })
      return new Response(`${url.origin}/api/share/access/${id}?pwd=${password}`)
    }

    // 15. 修改密码
    if (path === "/api/change-pwd") {
      const { newUser, newPass } = await request.json()
      USER = newUser
      PASS = newPass
      return new Response("ok")
    }

    // 16. 多用户：列表（简化版）
    if (path === "/api/users") {
      return Response.json([{ user: USER, isAdmin: true }])
    }

    // 17. 多用户：创建
    if (path === "/api/create-user") {
      return new Response("Admin only", { status: 403 })
    }

    // 18. 多用户：删除
    if (path === "/api/delete-user") {
      return new Response("Admin only", { status: 403 })
    }

    // 19. 离线下载
    if (path === "/api/offline-download") {
      const { url } = await request.json()
      ctx.waitUntil((async () => {
        try {
          const res = await fetch(url)
          await s3Client.send(new PutObjectCommand({ Bucket: S3_CONFIG.bucket, Key: url.split("/").pop(), Body: await res.arrayBuffer() }))
        } catch {}
      })())
      return new Response("ok")
    }

    // 20. 加密
    if (path === "/api/encrypt-folder") {
      const { key, password } = await request.json()
      password ? encryptMap.set(key, password) : encryptMap.delete(key)
      return new Response("ok")
    }

    return new Response("Not found", { status: 404 })
  }
}
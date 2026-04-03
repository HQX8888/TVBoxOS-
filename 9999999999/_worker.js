import {
  S3Client,
  ListObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand
} from "@aws-sdk/client-s3";

// ================= 配置区（修改为你自己的） =================
const S3_CONFIG = {
  region: "cn-east-1",
  endpoint: "https://s3.hi168.com", // 七牛云/又拍云/阿里云 按服务商改
  credentials: {
    accessKeyId: "D1AASIIKMSR8GXRD5EQM",
    secretAccessKey: "WltIDXSaMbyl8ILAaWJTsPx9Cb8zFcPYA6kymMvr"
  },
  forcePathStyle: true,
  Bucket: "CF网盘"
};

// 账号密码（用 let 方便修改）
let USER = "admin";
let PASS = "123456";

// ================= 初始化 =================
const s3 = new S3Client(S3_CONFIG);
let shareMap = new Map();
let uploadMap = new Map();

// ================= 工具函数 =================
function parsePath(req) {
  const url = new URL(req.url);
  return url.pathname;
}

function checkAuth(req) {
  const auth = req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  try {
    const token = atob(auth.slice(7));
    const [user, pass] = token.split(":");
    if (user === USER && pass === PASS) {
      return { user, isAdmin: true };
    }
  } catch {}
  return null;
}

// ================= 主逻辑 =================
export default {
  async fetch(req, env) {
    const path = parsePath(req);

    // 1. 首页
    if (path === "/" || path === "/index.html") {
      return new Response(await env.ASSETS.fetch("index.html"), {
        headers: { "Content-Type": "text/html;charset=utf-8" }
      });
    }

    // 2. 登录接口
    if (path === "/api/login" && req.method === "POST") {
      try {
        const { user, pass } = await req.json();
        if (user === USER && pass === PASS) {
          return new Response(JSON.stringify({
            ok: true,
            token: btoa(`${user}:${pass}`),
            isAdmin: true
          }), { headers: { "Content-Type": "application/json" } });
        } else {
          return new Response(JSON.stringify({ ok: false }), { status: 401 });
        }
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
      }
    }

    // 权限校验
    const auth = checkAuth(req);
    if (!auth) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 3. 文件列表
    if (path === "/api/list") {
      try {
        const res = await s3.send(new ListObjectsCommand({ Bucket: S3_CONFIG.Bucket }));
        const items = (res.Contents || []).map(x => ({
          key: x.Key,
          name: x.Key.split("/").pop(),
          type: x.Key.endsWith("/") ? "folder" : "file",
          size: x.Size || 0
        }));
        return new Response(JSON.stringify(items), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // 4. 读取文件内容
    if (path.startsWith("/api/file/")) {
      const key = decodeURIComponent(path.slice(9));
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: S3_CONFIG.Bucket, Key: key }));
        return new Response(res.Body, { headers: { "Content-Type": "application/octet-stream" } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }

    // 5. 上传文件（简单模式）
    if (path === "/api/upload" && req.method === "POST") {
      try {
        const { key, data } = await req.json();
        await s3.send(new PutObjectCommand({
          Bucket: S3_CONFIG.Bucket,
          Key: key,
          Body: new Uint8Array(data)
        }));
        return new Response("ok");
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // 6. 删除文件
    if (path === "/api/delete" && req.method === "POST") {
      try {
        const { key } = await req.json();
        await s3.send(new DeleteObjectCommand({ Bucket: S3_CONFIG.Bucket, Key: key }));
        return new Response("ok");
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // 7. 新建文件夹
    if (path === "/api/mkdir" && req.method === "POST") {
      try {
        const { name } = await req.json();
        await s3.send(new PutObjectCommand({
          Bucket: S3_CONFIG.Bucket,
          Key: `${name}/`,
          Body: ""
        }));
        return new Response("ok");
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // 8. 修改密码（修复后的写法）
    if (path === "/api/change-password" && req.method === "POST") {
      try {
        const { newUser, newPass } = await req.json();
        if (newUser) USER = newUser;
        if (newPass) PASS = newPass;
        return new Response("ok");
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // 默认404
    return new Response("Not found", { status: 404 });
  }
};
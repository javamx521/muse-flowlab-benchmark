/**
 * FlowLab Studio Service Worker（M5）。
 * 策略：应用壳（HTML/JS/CSS）缓存优先 + 后台更新；其他同源 GET 请求网络优先、失败回退缓存。
 * 版本号由构建时注入的 __FLOWLAB_SW_VERSION__ 决定；新版本安装后跳过等待，由页面提示用户刷新。
 */
/** 最小的 ServiceWorker 全局声明（tsconfig 未引入 WebWorker lib 时使用）。 */
interface ServiceWorkerGlobalScopeLike {
  readonly registration: { readonly scope: string };
  readonly clients: { claim(): Promise<void> };
  addEventListener(
    type: string,
    listener: (event: Event & { data?: unknown; waitUntil?: (p: Promise<unknown>) => void }) => void,
  ): void;
  skipWaiting(): Promise<void>;
}
declare const __FLOWLAB_SW_VERSION__: string;
/** ServiceWorker 全局对象：经 globalThis 获取，避免与 DOM lib 的 self 声明冲突。 */
const swSelf = globalThis as unknown as ServiceWorkerGlobalScopeLike;

/** 最小的 FetchEvent 声明（tsconfig 未引入 WebWorker lib 时使用）。 */
interface FetchEventLike {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}

const VERSION = __FLOWLAB_SW_VERSION__;
const CACHE_NAME = `flowlab-studio-${VERSION}`;
// 作用域相对路径（GitHub Pages 子路径部署时也能工作）
const SCOPE_PATH = new URL(swSelf.registration.scope).pathname;

async function cacheAppShell(): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  // 缓存应用入口与静态资源；忽略单文件失败，避免整体安装失败
  const urls = [`${SCOPE_PATH}`, `${SCOPE_PATH}index.html`];
  await Promise.all(
    urls.map((u) =>
      cache.add(u).catch(() => {
        /* 离线首次安装时可能失败，运行时再补 */
      }),
    ),
  );
}

swSelf.addEventListener('install', (event) => {
  event.waitUntil!(
    cacheAppShell().then(() => {
      // 新版本立即进入 waiting，由页面决定何时激活
    }),
  );
});

swSelf.addEventListener('activate', (event) => {
  event.waitUntil!(
    (async () => {
      // 清理旧版本缓存
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('flowlab-studio-') && k !== CACHE_NAME).map((k) => caches.delete(k)),
      );
      await swSelf.clients.claim();
    })(),
  );
});

swSelf.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    void swSelf.skipWaiting();
  }
});

swSelf.addEventListener('fetch', (event) => {
  const fetchEvent = event as unknown as FetchEventLike;
  const { request } = fetchEvent;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // 仅处理同源请求
  if (url.origin !== new URL(swSelf.registration.scope).origin) return;

  const isAppShell =
    url.pathname === SCOPE_PATH ||
    url.pathname === `${SCOPE_PATH}index.html` ||
    url.pathname.startsWith(`${SCOPE_PATH}assets/`);

  if (isAppShell) {
    // 应用壳：缓存优先，后台更新
    fetchEvent.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request, { ignoreSearch: false });
        const network = fetch(request)
          .then((res) => {
            if (res.ok) void cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        if (cached) {
          // 后台刷新，不阻塞返回
          void network;
          return cached;
        }
        const res = await network;
        if (res) return res;
        // 完全离线且无缓存：返回 index.html（SPA 回退）
        const fallback = await cache.match(`${SCOPE_PATH}index.html`);
        if (fallback) return fallback;
        return new Response('离线且无缓存', { status: 503 });
      })(),
    );
  } else {
    // 其他同源资源：网络优先，失败回退缓存
    fetchEvent.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          if (res.ok) {
            const cache = await caches.open(CACHE_NAME);
            void cache.put(request, res.clone());
          }
          return res;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(request);
          if (cached) return cached;
          return new Response('离线', { status: 503 });
        }
      })(),
    );
  }
});

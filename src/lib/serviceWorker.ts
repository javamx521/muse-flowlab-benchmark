/**
 * Service Worker 注册与更新管理（M5）。
 * 仅在生产构建启用；开发环境跳过（避免缓存干扰调试）。
 */

export type SwUpdateState = 'none' | 'available' | 'activated';

let registration: ServiceWorkerRegistration | null = null;
let onUpdateCallback: ((state: SwUpdateState) => void) | null = null;

export function onSwUpdate(cb: (state: SwUpdateState) => void): void {
  onUpdateCallback = cb;
}

function notify(state: SwUpdateState): void {
  onUpdateCallback?.(state);
}

/** 注册 SW；发现新版本时通知 UI 提示用户刷新。 */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  // 开发环境不注册
  if (import.meta.env.DEV) return;
  try {
    const base = import.meta.env.BASE_URL; // '/muse-flowlab-benchmark/'
    registration = await navigator.serviceWorker.register(`${base}sw.js`, {
      scope: base,
    });

    // 已有 waiting 的 SW（上次访问时下载的新版本）
    if (registration.waiting) {
      notify('available');
    }

    registration.addEventListener('updatefound', () => {
      const worker = registration!.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          // 新版本已就绪，等待用户确认后激活
          notify('available');
        }
      });
    });

    // SW 激活后（用户点了"立即更新"），通知 UI 可刷新
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      notify('activated');
    });
  } catch {
    // SW 注册失败不影响主功能（隐私模式等），静默忽略
  }
}

/** 用户确认更新：让 waiting 的 SW 跳过等待并接管。 */
export function applySwUpdate(): void {
  registration?.waiting?.postMessage('SKIP_WAITING');
}

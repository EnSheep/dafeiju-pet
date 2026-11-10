/**
 * 桌面应用对自身窗口的媒体权限放行。
 *
 * Electron 默认**拒绝**所有 `getUserMedia` 请求：没有装 `setPermissionRequestHandler` 时
 * `navigator.mediaDevices.getUserMedia({audio:true})` 直接抛 `NotAllowedError`，表现为
 * 「按住说话没反应 / 点了麦克风不出字」。DSH 主机自己装了处理器，所以插件跑在 DSH 里时正常，
 * 独立应用这边必须补上。
 *
 * 只放行媒体相关权限；本 session 只服务桌宠自己的 file 渲染页与设置页，不含第三方内容。
 * @module dsh-pet/src/app/permissions
 */

/** 主进程默认 session 的最小形态（只用到权限两个钩子）。 */
export interface PermissionSession {
  setPermissionRequestHandler(
    handler: (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: { requestingUrl?: string; mediaTypes?: readonly string[] },
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      contents: unknown,
      permission: string,
      requestingOrigin: string,
      details: { requestingUrl?: string; mediaType?: string },
    ) => boolean,
  ): void;
}

/**
 * 放行的权限白名单。
 *
 * `media` 覆盖麦克风/摄像头（Windows 上 `audioCapture` 只会作为 `media` 出现，但 Linux 上会
 * 单独来一次，两个都写上省得平台差异咬人）；`display-capture` 给对话里的截屏按钮用。
 */
const ALLOWED = new Set(['media', 'audioCapture', 'videoCapture', 'display-capture']);

/**
 * 给自己的窗口放行媒体权限。
 *
 * 不按发起地址做白名单：本 session 里所有内容都是本应用自己加载的（file 渲染页 + 本机设置页），
 * 而 `getUserMedia` 的 `requestingUrl` 在 file 协议下是 `file://`，比对具体路径只会更脆。
 *
 * @param session - 主进程默认 session。
 * @param log - 可选日志回调；每次请求都记一行，便于下次「录不到音」时一眼看出卡在哪。
 */
export function installMediaPermissions(
  session: PermissionSession,
  log?: (message: string) => void,
): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const granted = ALLOWED.has(permission);
    log?.(`权限请求 ${permission}${details?.requestingUrl ? ' ← ' + details.requestingUrl : ''} → ${granted ? '放行' : '拒绝'}`);
    callback(granted);
  });
  session.setPermissionCheckHandler((_contents, permission) => ALLOWED.has(permission));
}

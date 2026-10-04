/**
 * onboarding 记录服务 RPC 的超时兜底（C47）。
 *
 * 为什么需要：onboardingRecordService 经 ProxyChannel 投影（packages/client 的
 * remoteServiceAccess），当 host 未注册该 channel 或链路无响应时，方法返回的
 * promise 永不结算。appendRecord 若被 await，保存按钮会永远转圈；dismissOnboarding
 * 虽是 fire-and-forget，挂住的 promise 与其闭包也永不回收。
 * 统一在这里给一次 5s 强制结算：超时即按「写失败」处理，交由调用方 catch 记 warn；
 * 这是纯超时兜底，不改任何交互语义——成功路径的后续动作与之前完全一致。
 *
 * 5s 的依据：appendRecord 路径先前已用同一数值（且 RPC 往返在本地 host 上为毫秒级，
 * 5s 足以区分「慢」与「永远不会回来」）。
 */
export function withOnboardingRpcTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 5000,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(label + " timeout")), timeoutMs);
    }),
  ]);
}

/**
 * 凭据 v2 的加密契约（P1）。
 *
 * 读侧容忍历史格式（明文、`enc:v1:`），写侧恒写 `enc:v2:`；未知 `enc:` 前缀一律
 * 明确报错，不再按明文返回 —— 明文容忍会把「密钥不对」伪装成「值就是这个字符串」。
 * 加密/解密允许返回 Promise：默认密钥可能来自系统凭据库（异步），
 * 由调用方 `await`；已有的同步调用点必须显式改造或在启动期先解析（见 CONTRACT.md）。
 */
export interface CredentialCipher {
  encrypt(value: string): string | Promise<string>;
  decrypt(value: string): string | Promise<string>;
  needsMigration?(value: string): boolean;
}

export interface SystemCredentialCipher extends CredentialCipher {
  /** 独立 Server/无头形态在开放服务前验证密钥后端；不返回密钥。 */
  initialize(): Promise<void>;
  /**
   * 数据根复制后，保证目标凭据路径的密钥条目能满足复制过去的依赖；不读出密钥。
   *
   * 系统条目按凭据文件路径区分，切换数据存储路径只复制 credentials.json 与
   * credential-source；新根没有条目，来源又固定为 os，启动后既解不开原凭据也不能生成
   * 新密钥（ZCT-2120723935487688704）。由密钥 owner 把同一把密钥登记到目标路径即可。
   * 目标条目已满足时不加载本目录密钥；目标已登记另一把密钥时拒绝覆盖。
   * `targetKeyStore` 只供测试替换目标条目。
   */
  shareKeyWithCopiedCredentials(
    targetFilePath: string,
    targetKeyStore?: CredentialKeyStore,
  ): Promise<void>;
}

/**
 * 系统凭据库条目访问面。仅后端可持有；不得通过 RPC 暴露，也不得把密钥写入日志。
 * 测试通过注入实现覆盖「钥匙串可用/不可用/配额满/写后读回不一致」。
 */
export interface CredentialKeyStore {
  /** 条目不存在返回 null；其余失败必须抛出（调用方据此分类 read 阶段）。 */
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}

export interface SystemCredentialCipherOptions {
  /** 凭据文件绝对路径；密钥命名由它推导，必须与写入方用同一解析器。 */
  filePath: string;
  env?: Readonly<Record<string, string | undefined>>;
  keyStore?: CredentialKeyStore;
  /**
   * 是否允许在「未绑定来源」的凭据目录上首次生成密钥并发布私有文件兜底。
   * 桌面 Host / 桌面内置 agent / 独立 CLI 为 true；独立 Server、无头 npm、Docker 必须为 false
   * ——容器重建会静默丢密钥，用户表现为「身份无故消失」，拒绝就绪至少可诊断。
   */
  allowKeyCreation?: boolean;
  /** 回退到私有 credential-secret 时回调一次；不接收密钥、路径或凭据值。 */
  onFallback?(): void;
}

/** 键值容器：迁移、批处理与写入闸门都按整组记录工作。 */
export type CredentialRecord = Record<string, string>;

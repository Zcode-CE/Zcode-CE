/** 驱动错误码 → ZCode broker 错误码。未知码归 internal。 */
export declare function brokerCodeForDriverCode(code: unknown): string;

export declare class CuaBrokerError extends Error {
  code: string;
  actionSent: boolean;
  details?: unknown;
  constructor(
    message: string,
    options?: { code?: string; actionSent?: boolean; details?: unknown },
  );
}

export declare function textBlock(text: string): { type: "text"; text: string };
export declare function jsonBlock(value: unknown): { type: "text"; text: string };
export declare function imageBlock(
  base64: string,
  mimeType: string,
): { type: "image"; data: string; mimeType: string };

export interface CuaDriverEnvelope {
  parsed: Record<string, unknown>;
  isError: boolean;
  structured: Record<string, any>;
  texts: string[];
  images: { type: "image"; data: string; mimeType?: string }[];
}

export declare function okResult(options?: {
  content?: unknown[];
  structuredContent?: unknown;
}): unknown;

export declare function errorResult(options: {
  code: string;
  message: string;
  actionSent?: boolean;
  details?: unknown;
}): unknown;

export declare function readDriverEnvelope(rawJson: unknown): CuaDriverEnvelope;
export declare function refusalOf(
  envelope: CuaDriverEnvelope,
): { code: string; message: string } | undefined;
export declare function actionDelivered(envelope: CuaDriverEnvelope): boolean;

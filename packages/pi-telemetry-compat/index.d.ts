// 对齐 @earendil-works/pi-ai 1.3.0 的类型引用；此包不提供遥测运行时。
export type AttributeValue =
  string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];
export interface SpanAttributes {
  [name: string]: AttributeValue | undefined;
}
export interface SpanOptions {
  name: string;
  attributes?: SpanAttributes;
}
export type SpanStatus =
  { status: 'ok' } | { status: 'error'; error?: { name: string; message: string } };
export interface TelemetryContext {
  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}
export interface TelemetrySpan extends TelemetryContext {
  addEvent(name: string, attributes?: SpanAttributes): void;
  setAttributes(attributes: SpanAttributes): void;
  setStatus(status: SpanStatus): void;
}

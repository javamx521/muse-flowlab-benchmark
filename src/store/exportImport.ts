/**
 * 工程导入导出（F07）。
 *
 * - 导出：完整 ProjectDocument（含快照与数据引用——csv/json 文本在节点 params 内，
 *   synthetic 用种子复现，因此文档自包含，在新浏览器可恢复）。
 * - 导入：结构验证 + 版本迁移；默认创建独立新项目（新 id），绝不静默覆盖现有项目；
 *   损坏文件返回明确错误，不清空当前项目。
 */
import { APP_VERSION } from '../lib/version';
import type { ProjectDocument } from './document';
import { validateAndMigrate } from './migrate';

export const EXPORT_KIND = 'flowlab-studio-export';

export interface ExportedProject {
  kind: typeof EXPORT_KIND;
  appVersion: string;
  exportedAt: string;
  document: ProjectDocument;
}

/** 导出为可下载的 JSON 文本。 */
export function serializeExport(doc: ProjectDocument): string {
  const payload: ExportedProject = {
    kind: EXPORT_KIND,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    document: doc,
  };
  return JSON.stringify(payload, null, 2);
}

export type ParseImportResult =
  | { ok: true; doc: ProjectDocument }
  | { ok: false; error: string };

/** 解析导入文件。成功返回迁移后的文档（调用方分配新 id/名称后保存）。 */
export function parseImport(text: string): ParseImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是有效的 JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || (parsed as { kind?: unknown }).kind !== EXPORT_KIND) {
    return { ok: false, error: '不是 FlowLab Studio 导出的工程文件' };
  }
  const doc = (parsed as ExportedProject).document;
  const r = validateAndMigrate(doc);
  if (!r.ok) return { ok: false, error: `工程校验失败：${r.error}` };
  return { ok: true, doc: r.doc };
}

/** 为导入的文档分配新身份（独立项目，不覆盖）。 */
export function adoptImported(doc: ProjectDocument, newId: string, newName: string): ProjectDocument {
  return {
    ...doc,
    id: newId,
    name: newName,
    snapshots: doc.snapshots.map((s) => ({ ...s })),
  };
}

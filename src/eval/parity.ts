import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function checkProviderParity(text: string, solo = false) {
  const rows = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
  const requests = rows.filter(row => row.type === 'provider_request');
  const endpoints = rows.filter(row => row.type === 'provider_endpoint' || (row.type === 'provider_request' && row.host));
  const tools = [...new Set(requests.flatMap(row => row.toolNames ?? row.system?.toolNames ?? []))].sort() as string[];
  const used = [...new Set(rows.flatMap(row => row.toolCalls ?? []))].sort() as string[];
  const urls = [...new Set(endpoints.map(row => row.url ?? `https://${row.host}${row.path}`))].sort();
  const models = [...new Set(requests.map(row => row.model))].sort();
  const efforts = [...new Set(requests.map(row => row.effort))].sort();
  const violations: string[] = [];
  if (!requests.length) violations.push('No captured requests');
  if (!endpoints.length) violations.push('No captured provider endpoints');
  if (urls.some(url => url !== 'https://chatgpt.com/backend-api/codex/responses')) violations.push('Endpoint mismatch');
  if (models.some(model => model !== 'gpt-6.1-sol' && model !== 'openai-codex/gpt-6.1-sol')) violations.push('Model mismatch');
  if (efforts.some(effort => effort !== 'high')) violations.push('Effort mismatch');
  if (solo && [...tools, ...used].some(name => name.startsWith('orche_'))) violations.push('pi-solo exposed/used orchestration tools');
  if (rows.some(row => row.type === 'provider_blocked' || row.type === 'trace_failure')) violations.push('Provider guard/capture failure');
  return { passed: violations.length === 0, requests: requests.length, urls, models, efforts, toolsOffered: tools, toolsUsed: used, violations, enforcedRequests: requests.filter(row => row.enforced).length };
}
export async function writeParityArtifact(outDir: string, solo = false) {
  const result = checkProviderParity(await readFile(join(outDir, 'provider-requests.jsonl'), 'utf8'), solo);
  await writeFile(join(outDir, 'parity.json'), JSON.stringify(result, null, 2));
  return result;
}

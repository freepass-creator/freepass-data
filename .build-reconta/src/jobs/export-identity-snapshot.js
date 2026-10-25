/** 정체성 승격 계획서 입력 내보내기(읽기 전용, 쓰기 0). B3Q 에서:
 *   npm run export:identity-snapshot -- (--erp5-capture <캡처.json> | --products-json <문서 덤프.json>) [--master <마스터 스냅샷.json>] --out <snapshot.json> [--all]
 * --master 가 없으면 활성 차종 마스터를 Data 게이트웨이로 읽는다(읽기 전용 트랜잭션). 결과를 그대로
 *   node dist/src/jobs/build-identity-promotion-plan.js --input <snapshot.json> --out <plan.json>
 * 에 넣는다(전체 번호 없음, 끝 4자리만). */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifiedErp5CaptureFromJson } from '../adapters/vehicle-identity-inputs.js';
import { identityMastersFromSnapshot, identityProductsFromCapture, identityProductsFromPlainDocs } from '../adapters/identity-snapshot.js';
import { captureVehicleMasterSnapshotReadOnly } from './data-access-runtime.js';
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
export async function exportIdentitySnapshot(input) {
    // 상품 입력은 둘 중 하나: 봉인 ERP5 캡처(--erp5-capture) 또는 평문 문서 덤프(--products-json, [{ id, data }] — 운영 읽기 전용 조회 결과).
    if (!input.erp5Capture === !input.productsJson)
        throw new Error('IDENTITY_SNAPSHOT_ONE_PRODUCT_INPUT_REQUIRED');
    const master = input.master ? JSON.parse(await readFile(input.master, 'utf8'))
        : await (input.readMaster ?? captureVehicleMasterSnapshotReadOnly)();
    let products, sourceLabel;
    if (input.erp5Capture) {
        const capture = verifiedErp5CaptureFromJson(JSON.parse(await readFile(input.erp5Capture, 'utf8')));
        products = identityProductsFromCapture(capture, { includeAll: input.includeAll === true });
        sourceLabel = `capture ${capture.digest.slice(0, 12)}`;
    }
    else {
        const docs = JSON.parse(await readFile(input.productsJson, 'utf8'));
        if (!Array.isArray(docs))
            throw new Error('IDENTITY_SNAPSHOT_PRODUCTS_INVALID');
        products = identityProductsFromPlainDocs(docs, { includeAll: input.includeAll === true });
        sourceLabel = `plain-docs ${products.length}`;
    }
    const masters = identityMastersFromSnapshot(master);
    const label = `identity-snapshot ${sourceLabel} master ${String(master.digest ?? '').slice(0, 12)}`;
    await writeFile(input.out, JSON.stringify({ label, products, masters }, null, 2), { mode: 0o600 });
    return { status: 'EXPORTED', writes: 0, products: products.length, masters: masters.length, label };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const erp5Capture = arg('--erp5-capture'), productsJson = arg('--products-json'), out = arg('--out');
    if ((!erp5Capture && !productsJson) || !out) {
        console.error('IDENTITY_SNAPSHOT_ARGS_REQUIRED');
        process.exitCode = 1;
    }
    else
        exportIdentitySnapshot({ erp5Capture, productsJson, master: arg('--master'), out, includeAll: process.argv.includes('--all') })
            .then(r => console.log(JSON.stringify(r)))
            .catch(e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'IDENTITY_SNAPSHOT_FAILED'); process.exitCode = 1; });
}

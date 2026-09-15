import { getRepository } from "../src/lib/db/repository";
import { fetchItemDetailPhotos } from "../src/lib/sources/courtauction/detail";
import { saveBase64Photo } from "../src/lib/storage/photos";
import { getDb } from "../src/lib/db/client";

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const repo = getRepository();
  const db = getDb();
  
  // 백오프 상태 확인
  const getBackoffState = db.prepare("SELECT value FROM collector_state WHERE key = 'backoff_until'");
  const row = getBackoffState.get() as { value: string } | undefined;
  if (row) {
    const backoffUntil = new Date(row.value);
    if (backoffUntil > new Date()) {
      console.log(`Backoff active until ${row.value}. Skipping photos run.`);
      return;
    }
  }

  const items = repo.getPendingPhotoItems(10);
  
  if (items.length === 0) {
    console.log("No pending photo items.");
    return;
  }

  for (const item of items) {
    if (!item.internalCaseNo || !item.courtCode) {
      repo.updateItemPhotoStatus(item.id, "failed");
      continue;
    }

    try {
      console.log(`Fetching photos for item ${item.id} (case: ${item.internalCaseNo}, court: ${item.courtCode})`);
      const pics = await fetchItemDetailPhotos(item.courtCode, item.internalCaseNo);
      
      if (pics.length === 0) {
        repo.updateItemPhotoStatus(item.id, "empty");
      } else {
        const savedPhotos = [];
        for (const pic of pics) {
          if (!pic.base64 || pic.seq == null) continue;
          
          const saved = saveBase64Photo(item.id, pic.seq, pic.base64);
          savedPhotos.push({
            seq: pic.seq,
            filePath: saved.filePath,
            fileSize: saved.fileSize,
            mimeType: saved.mimeType
          });
        }
        
        if (savedPhotos.length > 0) {
          repo.saveItemPhotos(item.id, savedPhotos, "collected");
        } else {
          repo.updateItemPhotoStatus(item.id, "empty");
        }
      }
    } catch (error) {
      console.error(`Failed to fetch photos for item ${item.id}:`, error);
      repo.updateItemPhotoStatus(item.id, "failed");
      
      // 만약 429나 접속 오류가 발생하면 백오프를 설정할 수 있음.
      if (error instanceof Error && error.message.includes("HTTP")) {
         const backoffTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
         db.prepare(`
           INSERT INTO collector_state (key, value, updated_at) 
           VALUES ('backoff_until', @value, @now)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
         `).run({ value: backoffTime, now: new Date().toISOString() });
      }
    }
    
    // 저속 수집을 위해 간격 두기 (3초)
    await delay(3000);
  }
}

if (require.main === module) {
  run().catch(console.error);
}

import * as XLSX from 'xlsx';
import { prisma } from '../../shared/db';
import { logger } from '../../shared/logger';

interface ImportResult {
  total: number;
  created: number;
  duplicates: number;
  errors: number;
}

/** Normalize phone number: strip spaces, dashes, ensure no leading + */
function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-()]/g, '');
  // Must be numeric (optionally starting with +)
  const digits = cleaned.replace(/^\+/, '');
  if (!/^\d{7,15}$/.test(digits)) return null;
  return digits;
}

export async function importFromBuffer(
  buffer: Buffer,
  fileName: string,
): Promise<ImportResult> {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('No sheets found in file');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet);

  let created = 0;
  let duplicates = 0;
  let errors = 0;

  for (const row of rows) {
    // Try common column names for phone
    const rawPhone = String(
      row['phone'] || row['Phone'] || row['phoneNumber'] || row['Phone Number'] ||
      row['mobile'] || row['Mobile'] || row['number'] || row['Number'] || ''
    ).trim();

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      errors++;
      continue;
    }

    const name = String(
      row['name'] || row['Name'] || row['Full Name'] || row['fullName'] || ''
    ).trim() || null;

    // Tags from comma-separated column
    const rawTags = String(row['tags'] || row['Tags'] || '').trim();
    const tags = rawTags ? rawTags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];

    try {
      await prisma.contact.upsert({
        where: { phoneNumber: phone },
        create: { phoneNumber: phone, name, tags },
        update: {}, // Don't overwrite existing contacts
      });
      created++;
    } catch (err: any) {
      if (err.code === 'P2002') {
        duplicates++;
      } else {
        logger.error({ err, phone }, 'Import row error');
        errors++;
      }
    }
  }

  return { total: rows.length, created, duplicates, errors };
}

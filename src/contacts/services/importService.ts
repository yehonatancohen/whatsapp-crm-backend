import * as XLSX from 'xlsx';
import { prisma } from '../../shared/db';
import { logger } from '../../shared/logger';

interface ImportErrorDetail {
  row: number;
  phone: string;
  reason: string;
}

interface ImportResult {
  total: number;
  created: number;
  duplicates: number;
  errors: number;
  errorDetails: ImportErrorDetail[];
  listId?: string;
  listName?: string;
}

const MAX_ERROR_DETAILS = 50;

/** Normalize phone number: strip separators, store with + prefix */
export function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s\-().\/]/g, '');
  const digits = cleaned.replace(/^\+/, '');
  if (!/^\d{7,15}$/.test(digits)) return null;
  return `+${digits}`;
}

export async function importFromBuffer(
  buffer: Buffer,
  fileName: string,
  options?: { listName?: string; userId?: string },
): Promise<ImportResult> {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('No sheets found in file');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet);

  let created = 0;
  let duplicates = 0;
  let errors = 0;
  const errorDetails: ImportErrorDetail[] = [];

  // Build a case-insensitive column lookup from the first row
  const columnKeys = rows.length > 0 ? Object.keys(rows[0]) : [];
  const findColumn = (candidates: string[]): string | undefined => {
    const lower = candidates.map((c) => c.toLowerCase());
    return columnKeys.find((k) => lower.includes(k.toLowerCase()));
  };

  const phoneCol = findColumn(['phone', 'phoneNumber', 'phone number', 'phone_number', 'mobile', 'number', 'tel', 'telephone']);
  const nameCol = findColumn(['name', 'full name', 'fullName', 'full_name', 'contact name', 'contact_name']);

  if (!phoneCol) {
    logger.error({ columns: columnKeys }, 'Import failed: no phone column found');
    return {
      total: rows.length,
      created: 0,
      duplicates: 0,
      errors: rows.length,
      errorDetails: [{ row: 0, phone: '', reason: `No phone column found. Available columns: ${columnKeys.join(', ')}` }],
    };
  }

  logger.info({ phoneCol, nameCol, totalRows: rows.length }, 'Import started');

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const rawPhone = String(row[phoneCol] ?? '').trim();

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      logger.debug({ rawPhone }, 'Skipping row: invalid phone number');
      errors++;
      if (errorDetails.length < MAX_ERROR_DETAILS) {
        errorDetails.push({ row: rowIndex + 2, phone: rawPhone, reason: 'Invalid phone number format' });
      }
      continue;
    }

    const name = (nameCol ? String(row[nameCol] ?? '').trim() : '') || null;

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
        if (errorDetails.length < MAX_ERROR_DETAILS) {
          errorDetails.push({ row: rowIndex + 2, phone, reason: 'Database error' });
        }
      }
    }
  }

  // Optionally create a contact list and add all successfully imported contacts to it
  let listId: string | undefined;
  let listName: string | undefined;

  if (options?.listName && options?.userId) {
    try {
      // Collect all phone numbers that were successfully imported (created or duplicates)
      const importedPhones: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const rawPhone = String(rows[i][phoneCol!] ?? '').trim();
        const phone = normalizePhone(rawPhone);
        if (phone) importedPhones.push(phone);
      }

      if (importedPhones.length > 0) {
        // Find matching contacts
        const contacts = await prisma.contact.findMany({
          where: { phoneNumber: { in: importedPhones } },
          select: { id: true },
        });

        if (contacts.length > 0) {
          const list = await prisma.contactList.create({
            data: {
              name: options.listName,
              userId: options.userId,
            },
          });

          await prisma.contactListEntry.createMany({
            data: contacts.map((c) => ({
              contactId: c.id,
              contactListId: list.id,
            })),
            skipDuplicates: true,
          });

          listId = list.id;
          listName = list.name;
          logger.info({ listId, listName, contactCount: contacts.length }, 'Created contact list from import');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to create contact list from import');
    }
  }

  return { total: rows.length, created, duplicates, errors, errorDetails, listId, listName };
}

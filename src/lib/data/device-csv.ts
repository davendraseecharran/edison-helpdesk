/**
 * How one inventory row becomes one line of the CSV export: the columns in
 * the order the list shows them, with statuses and kinds in their labels
 * rather than their storage spellings, because the file is for a person. Pure,
 * so the shape of the export can be tested without a database.
 */

import type { DeviceSummaryRow } from '@/lib/data/mapping';
import {
  DEVICE_STATUS_LABELS,
  isDeviceStatus,
  isPersonKind,
  PERSON_KIND_LABELS,
} from '@/lib/domain/types';

export const DEVICE_CSV_COLUMNS = [
  'Asset tag',
  'Serial number',
  'Device ID',
  'Type',
  'Manufacturer',
  'Model',
  'OS',
  'Status',
  'Location',
  'Holder',
  'Holder kind',
  'Updated',
] as const;

export function deviceCsvRow(row: DeviceSummaryRow): unknown[] {
  return [
    row.asset_tag,
    row.serial_number,
    row.device_id,
    row.type,
    row.manufacturer,
    row.model,
    row.os,
    isDeviceStatus(row.status) ? DEVICE_STATUS_LABELS[row.status] : row.status,
    row.location,
    row.holder_name,
    isPersonKind(row.holder_kind) ? PERSON_KIND_LABELS[row.holder_kind] : null,
    row.updated_at,
  ];
}

/**
 * How one inventory row becomes one line of the CSV export: the columns in
 * the order the list shows them, with the holder's kind in its label rather
 * than its storage spelling, because the file is for a person. Pure, so the
 * shape of the export can be tested without a database.
 *
 * The status needs no translation any more. `inventory_devices.status` is free
 * text the district writes for itself — Available, Assigned, In repair — so
 * what is stored is already what a person reads.
 */

import type { DeviceSummary } from '@/lib/domain/types';
import { isPersonKind, PERSON_KIND_LABELS } from '@/lib/domain/types';

export const DEVICE_CSV_COLUMNS = [
  'Asset tag',
  'Serial number',
  'Inventory ID',
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

export function deviceCsvRow(device: DeviceSummary): unknown[] {
  return [
    device.assetTag,
    device.serialNumber,
    device.externalId,
    device.deviceType,
    device.manufacturer,
    device.model,
    device.osVersion,
    device.status,
    device.location,
    device.assignedName,
    isPersonKind(device.assignedKind) ? PERSON_KIND_LABELS[device.assignedKind] : null,
    device.updatedAt,
  ];
}

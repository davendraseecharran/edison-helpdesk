export type PersonKind = 'student' | 'staff';
export interface PersonRecord {
  id: string; kind: PersonKind; displayName: string; externalId: string;
  firstName: string; lastName: string; email: string;
  schoolDbn: string; department: string; staffRole: string;
  classOf: string; officialClass: string; studentStatus: 'current' | 'graduated' | 'other';
  guardianName: string; guardianPhone: string; homePhone: string; address: string; notes: string;
  version: number; updatedAt: string; deviceCount: number;
}
export interface ManagedDevice {
  id: string; externalId: string; deviceType: string; manufacturer: string; model: string;
  osVersion: string; serialNumber: string; assetTag: string; status: string; location: string; notes: string;
  assignedRequesterId: string | null; assignedName: string | null; assignedKind: PersonKind | null;
  version: number; updatedAt: string;
}
export interface InventoryPage<T> { rows: T[]; total: number; page: number; pageSize: number }
export type PersonInput = Omit<PersonRecord, 'id' | 'updatedAt' | 'deviceCount' | 'version'>;
export type DeviceInput = Omit<ManagedDevice, 'id' | 'externalId' | 'assignedName' | 'assignedKind' | 'version' | 'updatedAt'>;
export interface InventorySaveResult { ok: boolean; id?: string; error?: string }

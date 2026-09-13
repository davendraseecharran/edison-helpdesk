import { describe, expect, it } from 'vitest';
import {
  DEVICE_FIELDS,
  PEOPLE_FIELDS,
  PRESETS,
  detectPreset,
  normaliseHeader,
} from '../../src/lib/import/presets';

/** The three AppSheet exports, header for header, typo and colons included. */
const STUDENT_HEADERS = [
  'Student ID:',
  'Name',
  'studentEmail',
  'Parent',
  'parentNumber',
  'homeNumber',
  'Class of',
  'officalClass',
  'studentAddress',
  'Notes',
];
const STAFF_HEADERS = ['firstName', 'lastName', 'staffEmail', 'schoolDBN', 'Department:', 'Role:'];
const INVENTORY_HEADERS = [
  'DeviceID',
  'SerialNumber',
  'Type',
  'Manufacturer',
  'Model',
  'OS',
  'AssetTag',
  'Status',
  'Assigned To',
  'Location',
  'OSIS',
  'Student Name',
  'StaffID',
  'Staff Name',
  'Notes',
];

describe('normaliseHeader', () => {
  it('ignores case, spaces, colons and punctuation', () => {
    expect(normaliseHeader('Student ID:')).toBe(normaliseHeader('studentid'));
    expect(normaliseHeader(' Assigned To ')).toBe(normaliseHeader('assigned_to'));
    expect(normaliseHeader('Department:')).toBe('department');
  });

  it('keeps different headers apart', () => {
    expect(normaliseHeader('Student Name')).not.toBe(normaliseHeader('Staff Name'));
  });
});

describe('field lists', () => {
  it('names every people column the importer may write', () => {
    expect([...PEOPLE_FIELDS]).toEqual([
      'kind',
      'first_name',
      'last_name',
      'display_name',
      'email',
      'osis',
      'staff_id',
      'school_dbn',
      'department',
      'role_title',
      'official_class',
      'class_of',
      'parent_name',
      'parent_phone',
      'home_phone',
      'address',
      'notes',
    ]);
  });

  it('never offers the administrator-only archive switch', () => {
    expect(PEOPLE_FIELDS).not.toContain('active');
    expect(DEVICE_FIELDS).not.toContain('active');
  });

  it('names every device column including the holder columns', () => {
    expect([...DEVICE_FIELDS]).toEqual([
      'device_id',
      'serial_number',
      'asset_tag',
      'type',
      'manufacturer',
      'model',
      'os',
      'status',
      'location',
      'notes',
      'holder_kind',
      'holder_osis',
      'holder_staff_id',
      'holder_student_name',
      'holder_staff_name',
    ]);
  });
});

describe('PRESETS', () => {
  it('ships the three AppSheet tabs', () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual([
      'appsheet_students',
      'appsheet_staff',
      'appsheet_inventory',
    ]);
    for (const preset of PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });

  it('only maps and fixes fields the target table has', () => {
    for (const preset of PRESETS) {
      const allowed: readonly string[] = preset.kind === 'people' ? PEOPLE_FIELDS : DEVICE_FIELDS;
      for (const field of Object.keys(preset.map)) expect(allowed).toContain(field);
      for (const field of Object.keys(preset.fixed ?? {})) expect(allowed).toContain(field);
    }
  });

  it('maps the student export onto directory columns', () => {
    const students = PRESETS.find((preset) => preset.id === 'appsheet_students')!;
    expect(students.kind).toBe('people');
    expect(students.fixed).toEqual({ kind: 'student' });
    expect(students.map).toEqual({
      osis: 'Student ID:',
      display_name: 'Name',
      email: 'studentEmail',
      parent_name: 'Parent',
      parent_phone: 'parentNumber',
      home_phone: 'homeNumber',
      class_of: 'Class of',
      official_class: 'officalClass',
      address: 'studentAddress',
      notes: 'Notes',
    });
  });

  it('maps the staff export onto directory columns', () => {
    const staff = PRESETS.find((preset) => preset.id === 'appsheet_staff')!;
    expect(staff.kind).toBe('people');
    expect(staff.fixed).toEqual({ kind: 'staff' });
    expect(staff.map).toEqual({
      first_name: 'firstName',
      last_name: 'lastName',
      email: 'staffEmail',
      school_dbn: 'schoolDBN',
      department: 'Department:',
      role_title: 'Role:',
    });
  });

  it('maps the inventory export onto device columns', () => {
    const inventory = PRESETS.find((preset) => preset.id === 'appsheet_inventory')!;
    expect(inventory.kind).toBe('devices');
    expect(inventory.map).toEqual({
      device_id: 'DeviceID',
      serial_number: 'SerialNumber',
      asset_tag: 'AssetTag',
      type: 'Type',
      manufacturer: 'Manufacturer',
      model: 'Model',
      os: 'OS',
      status: 'Status',
      location: 'Location',
      notes: 'Notes',
      holder_kind: 'Assigned To',
      holder_osis: 'OSIS',
      holder_staff_id: 'StaffID',
      holder_student_name: 'Student Name',
      holder_staff_name: 'Staff Name',
    });
  });
});

describe('detectPreset', () => {
  it('recognises each AppSheet export', () => {
    expect(detectPreset(STUDENT_HEADERS)?.id).toBe('appsheet_students');
    expect(detectPreset(STAFF_HEADERS)?.id).toBe('appsheet_staff');
    expect(detectPreset(INVENTORY_HEADERS)?.id).toBe('appsheet_inventory');
  });

  it('ignores case, spacing, colons and column order', () => {
    expect(detectPreset(['name', 'STUDENT ID', ' studentemail ', 'class_of'])?.id).toBe(
      'appsheet_students',
    );
    expect(detectPreset(['Role', 'DEPARTMENT:', 'First Name', 'Last Name'])?.id).toBe(
      'appsheet_staff',
    );
  });

  it('still recognises an export that carries extra columns', () => {
    expect(detectPreset([...INVENTORY_HEADERS, 'Purchase order', 'Warranty ends'])?.id).toBe(
      'appsheet_inventory',
    );
  });

  it('returns null when nothing matches', () => {
    expect(detectPreset(['Ticket', 'Requester', 'Opened'])).toBeNull();
    expect(detectPreset([])).toBeNull();
  });

  it('returns null when fewer than three columns match', () => {
    expect(detectPreset(['Name', 'Notes'])).toBeNull();
  });
});

/**
 * The pure rules behind the directory and inventory screens: which field a
 * database message belongs beside, how a picker groups people, how a record
 * page arranges tickets, and how the URL filters are read.
 */

import { describe, expect, it } from 'vitest';
import {
  countLabel,
  deviceErrorField,
  directoryTailColumns,
  groupPeople,
  isGeneratedIdentifier,
  isLoopbackUrl,
  personErrorField,
  personPlacement,
  personSubtitle,
  splitRecordTickets,
} from '../src/lib/domain/records';
import { deviceLabel, SEED_DEVICE_STATUSES, ASSIGNED_STATUS } from '../src/lib/domain/types';
import { toPeopleFilters } from '../src/app/(app)/people/search-params';
import { pickerGateOpen, PICKER_MIN_CHARS } from '../src/components/directory/SearchPicker';

describe('personErrorField', () => {
  it('lands each database message beside the field it names', () => {
    // Verbatim from app_save_person and app_validate_profile.
    expect(personErrorField('OSIS must contain numbers only.')).toBe('externalId');
    expect(personErrorField('That OSIS or Staff ID is already in use. Open the existing record instead.')).toBe('externalId');
    expect(personErrorField('Staff email is required to calculate the Staff ID.')).toBe('email');
    expect(personErrorField('Enter a valid email address.')).toBe('email');
    expect(personErrorField('Enter a valid phone number for guardianPhone.')).toBe('guardianPhone');
    expect(personErrorField('Enter a valid phone number for homePhone.')).toBe('homePhone');
    expect(personErrorField('Class of must be a four-digit year.')).toBe('classOf');
    expect(personErrorField('Choose a valid enrollment status.')).toBe('studentStatus');
    expect(personErrorField('Choose staff or student.')).toBe('kind');
    expect(personErrorField('A name is required.')).toBe('displayName');
  });

  it('sends anything about the whole record to the foot of the form', () => {
    expect(personErrorField('This record changed since you opened it. Reload it before saving.')).toBeNull();
    expect(personErrorField('Your session is not able to make changes. Sign in again.')).toBeNull();
  });
});

describe('deviceErrorField', () => {
  it('lands each database message beside the field it names', () => {
    // Verbatim from app_save_inventory_device and app_validate_profile.
    expect(deviceErrorField('That serial number is already recorded in inventory.')).toBe('serialNumber');
    expect(deviceErrorField('The assetTag field is too long (maximum 120 characters).')).toBe('assetTag');
    expect(deviceErrorField('The deviceType field is too long (maximum 120 characters).')).toBe('deviceType');
    expect(deviceErrorField('The status field is too long (maximum 120 characters).')).toBe('status');
    expect(deviceErrorField('The location field is too long (maximum 120 characters).')).toBe('location');
    expect(deviceErrorField('Select an existing student or staff member for the assignment.')).toBe(
      'assignedRequesterId',
    );
  });

  it('sends a message about the whole record to the foot of the form', () => {
    expect(deviceErrorField('This device changed since you opened it. Reload it before saving.')).toBeNull();
    // Four fields at once cannot land beside one of them.
    expect(
      deviceErrorField('Device type, manufacturer, model and serial number are required.'),
    ).toBeNull();
  });
});

describe('groupPeople', () => {
  const people = [
    { id: 'a', kind: 'staff' as const, displayName: 'Renata Calloway' },
    { id: 'b', kind: 'student' as const, displayName: 'Amara Whitfield' },
    { id: 'c', kind: 'student' as const, displayName: 'Desmond Whitfield' },
  ];

  it('puts students first and keeps the search order inside each group', () => {
    const groups = groupPeople(people);
    expect(groups.map((group) => group.label)).toEqual(['Students', 'Staff']);
    expect(groups[0].items.map((person) => person.id)).toEqual(['b', 'c']);
    expect(groups[1].items.map((person) => person.id)).toEqual(['a']);
  });

  it('leaves out an empty group', () => {
    expect(groupPeople(people.filter((person) => person.kind === 'staff')).map((g) => g.label)).toEqual(['Staff']);
    expect(groupPeople([])).toEqual([]);
  });
});

describe('person lines', () => {
  it('reads kind, then class or department, without a middle dot', () => {
    expect(personSubtitle({ kind: 'student', officialClass: '9A', classOf: '2029' })).toBe('Student, 9A');
    expect(personSubtitle({ kind: 'student', classOf: '2029' })).toBe('Student, class of 2029');
    expect(personSubtitle({ kind: 'staff', department: 'Science', staffRole: 'Teacher' })).toBe('Staff, Science');
    expect(personSubtitle({ kind: 'staff' })).toBe('Staff');
    expect(personPlacement({ kind: 'student', officialClass: '9A', classOf: '2029' })).toBe('Class 9A, class of 2029');
    expect(personPlacement({ kind: 'staff', department: 'Science', staffRole: 'Teacher' })).toBe('Science, Teacher');
    expect(personPlacement({ kind: 'staff' })).toBe('');
  });

  it('pluralises counts', () => {
    expect(countLabel(1, 'device')).toBe('1 device');
    expect(countLabel(12, 'device')).toBe('12 devices');
    expect(countLabel(2, 'person', 'people')).toBe('2 people');
  });
});

describe('splitRecordTickets', () => {
  const tickets = [
    { id: '1', status: 'resolved' },
    { id: '2', status: 'open' },
    { id: '3', status: 'cancelled' },
    { id: '4', status: 'waiting' },
  ];

  it('puts live tickets first and caps the closed ones', () => {
    const { open, recent } = splitRecordTickets(tickets, 1);
    expect(open.map((ticket) => ticket.id)).toEqual(['2', '4']);
    expect(recent.map((ticket) => ticket.id)).toEqual(['1']);
  });
});

describe('deviceLabel', () => {
  it('names a machine by tag, then serial, then the inventory id', () => {
    expect(deviceLabel({ assetTag: 'DOE-LN1', serialNumber: 'S1', externalId: 'DEV-1' })).toBe('DOE-LN1');
    expect(deviceLabel({ assetTag: null, serialNumber: 'S1', externalId: 'DEV-1' })).toBe('S1');
    expect(deviceLabel({ assetTag: null, serialNumber: null, externalId: 'DEV-1' })).toBe('DEV-1');
    expect(deviceLabel({ assetTag: null, serialNumber: null, externalId: null })).toBe('Unlabelled device');
  });

  it('treats a blank the projection sent as no value at all', () => {
    // app_inventory_device_json coalesces every text field to '', so a machine
    // with no asset tag arrives with an empty string rather than a null.
    expect(deviceLabel({ assetTag: '', serialNumber: '  ', externalId: 'DEV-1' })).toBe('DEV-1');
  });

  it('seeds the status vocabulary without closing it', () => {
    expect(SEED_DEVICE_STATUSES).toContain(ASSIGNED_STATUS);
    expect(SEED_DEVICE_STATUSES).toContain('Available');
    // A plain string, so a status the district invents is a legal value.
    const invented: string = 'Awaiting parts';
    expect(SEED_DEVICE_STATUSES).not.toContain(invented);
  });
});

describe('directory filters from the URL', () => {
  it('reads one of the two lists, and falls back to students', () => {
    expect(toPeopleFilters({ kind: 'staff', page: '2' })).toMatchObject({
      kind: 'staff',
      page: 2,
    });
    expect(toPeopleFilters({ kind: 'parent' }).kind).toBe('student');
    expect(toPeopleFilters({}).kind).toBe('student');
    expect(toPeopleFilters({ query: ['Whit', 'ignored'] }).query).toBe('Whit');
    expect(toPeopleFilters({ page: '-3' }).page).toBe(1);
  });
});

describe('describeFieldList', () => {
  it('reads a created or updated event\'s column list in plain words', async () => {
    const { describeFieldList } = await import('../src/lib/domain/records');
    expect(describeFieldList('kind, first_name, external_id, school_dbn')).toBe(
      'kind, first name, OSIS or staff ID, school DBN',
    );
    expect(describeFieldList('asset_tag, os_version')).toBe('asset tag, OS');
  });

  it('leaves any other detail as written', async () => {
    const { describeFieldList } = await import('../src/lib/domain/records');
    expect(describeFieldList('Charger missing; screen scratched')).toBeNull();
    expect(describeFieldList(null)).toBeNull();
    expect(describeFieldList('')).toBeNull();
  });
});

describe('pickerGateOpen', () => {
  it('stays shut below the minimum, and below it once trimmed', () => {
    expect(PICKER_MIN_CHARS).toBe(2);
    expect(pickerGateOpen('')).toBe(false);
    expect(pickerGateOpen('a')).toBe(false);
    expect(pickerGateOpen('  a  ')).toBe(false);
    expect(pickerGateOpen('  ')).toBe(false);
  });

  it('opens at the minimum and beyond', () => {
    expect(pickerGateOpen('ab')).toBe(true);
    expect(pickerGateOpen('  ab  ')).toBe(true);
    expect(pickerGateOpen('Whitfield')).toBe(true);
    expect(pickerGateOpen('240000123')).toBe(true);
  });
});

describe('isGeneratedIdentifier', () => {
  it('recognises the name slug with a hex tail a record without an address gets', () => {
    expect(isGeneratedIdentifier('marcus.ellery-1e1ec7b6')).toBe(true);
    expect(isGeneratedIdentifier('nia_okonkwo-9f0a1b2c')).toBe(true);
    expect(isGeneratedIdentifier('shot-admin-1e1ec7b6')).toBe(true);
  });

  it('leaves alone the identifiers a school actually issues', () => {
    // A nine-digit OSIS, a staff ID that is the address they sign in with, and
    // the department or role a picker shows when there is no identifier.
    expect(isGeneratedIdentifier('212345678')).toBe(false);
    expect(isGeneratedIdentifier('mellery')).toBe(false);
    expect(isGeneratedIdentifier('m.ellery')).toBe(false);
    expect(isGeneratedIdentifier('Grade 6 ELA')).toBe(false);
    expect(isGeneratedIdentifier('Facilities')).toBe(false);
    expect(isGeneratedIdentifier('Room 212')).toBe(false);
  });

  it('is false for nothing at all', () => {
    expect(isGeneratedIdentifier(null)).toBe(false);
    expect(isGeneratedIdentifier(undefined)).toBe(false);
    expect(isGeneratedIdentifier('   ')).toBe(false);
  });
});

describe('isLoopbackUrl', () => {
  it('knows the addresses a phone camera cannot follow', () => {
    expect(isLoopbackUrl('http://127.0.0.1:3005/scan/abc')).toBe(true);
    expect(isLoopbackUrl('http://localhost:3000/scan/abc')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3000/scan/abc')).toBe(true);
  });

  it('leaves a hosted or network origin alone', () => {
    expect(isLoopbackUrl('https://edison-helpdesk.vercel.app/scan/abc')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.24:3005/scan/abc')).toBe(false);
  });

  it('treats something that is not a URL as not loopback', () => {
    expect(isLoopbackUrl('')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

describe('directoryTailColumns', () => {
  it('gives a technician the machines and the open tickets', () => {
    expect(directoryTailColumns(true)).toEqual(['devices', 'open']);
  });

  it('gives a skills officer the address and the rosters instead', () => {
    // They read no tickets and hand out no machines, so both of the other
    // columns would be the same value on every row.
    expect(directoryTailColumns(false)).toEqual(['email', 'groups']);
  });

  it('never shows the same column to both', () => {
    const worker = directoryTailColumns(true);
    const officer = directoryTailColumns(false);
    expect(worker.filter((key) => officer.includes(key))).toEqual([]);
  });
});

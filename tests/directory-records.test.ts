/**
 * The pure rules behind the directory and inventory screens: which field a
 * database message belongs beside, how a picker groups people, how a record
 * page arranges tickets, and how the URL filters are read.
 */

import { describe, expect, it } from 'vitest';
import {
  countLabel,
  deviceErrorField,
  groupPeople,
  personErrorField,
  personPlacement,
  personSubtitle,
  splitRecordTickets,
} from '../src/lib/domain/records';
import { deviceLabel, DEVICE_STATUSES, MANUAL_DEVICE_STATUSES } from '../src/lib/domain/types';
import { toPeopleFilters } from '../src/app/(app)/people/search-params';

describe('personErrorField', () => {
  it('lands each database message beside the field it names', () => {
    expect(personErrorField('An OSIS number is 6 to 12 digits. Check "24" and enter it again.')).toBe('osis');
    expect(personErrorField('Another person already has OSIS 240000123. Search for it to see whose record that is.')).toBe('osis');
    expect(personErrorField('Another person already has staff id EMP-4021. Search for it.')).toBe('staff_id');
    expect(personErrorField('Enter a valid email address, or leave the address blank.')).toBe('email');
    expect(personErrorField('Another person already has the address a@edison.example. Search for it.')).toBe('email');
    expect(personErrorField('Choose whether this person is a student or staff.')).toBe('kind');
    expect(personErrorField("Enter this person's name.")).toBe('first_name');
  });

  it('sends anything else to the foot of the form', () => {
    expect(personErrorField('Your session is not able to make changes. Sign in again.')).toBeNull();
  });
});

describe('deviceErrorField', () => {
  it('lands each database message beside the field it names', () => {
    expect(deviceErrorField('Another device already has asset tag DOE-LN1. Search for it.')).toBe('asset_tag');
    expect(deviceErrorField('Another device already has serial number PF3. Search for it.')).toBe('serial_number');
    expect(deviceErrorField('Another device already has device id PW0. Search for it.')).toBe('device_id');
    expect(deviceErrorField('A device is deployed once somebody is holding it. Assign it to a person instead.')).toBe('status');
    expect(deviceErrorField('This device is still assigned to someone. Return it first, and choose the status it came back in.')).toBe('status');
    expect(deviceErrorField('Enter a device id, serial number or asset tag so this machine can be identified.')).toBe('device_id');
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
    expect(personSubtitle({ kind: 'staff', department: 'Science', roleTitle: 'Teacher' })).toBe('Staff, Science');
    expect(personSubtitle({ kind: 'staff' })).toBe('Staff');
    expect(personPlacement({ kind: 'student', officialClass: '9A', classOf: '2029' })).toBe('Class 9A, class of 2029');
    expect(personPlacement({ kind: 'staff', department: 'Science', roleTitle: 'Teacher' })).toBe('Science, Teacher');
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
  it('names a machine by tag, then serial, then device id', () => {
    expect(deviceLabel({ assetTag: 'DOE-LN1', serialNumber: 'S1', deviceId: 'D1' })).toBe('DOE-LN1');
    expect(deviceLabel({ assetTag: null, serialNumber: 'S1', deviceId: 'D1' })).toBe('S1');
    expect(deviceLabel({ assetTag: null, serialNumber: null, deviceId: 'D1' })).toBe('D1');
    expect(deviceLabel({ assetTag: null, serialNumber: null, deviceId: null })).toBe('Unlabelled device');
  });

  it('never offers deployed as a status to set by hand', () => {
    expect(DEVICE_STATUSES).toContain('deployed');
    expect(MANUAL_DEVICE_STATUSES).not.toContain('deployed');
    expect(MANUAL_DEVICE_STATUSES).toHaveLength(DEVICE_STATUSES.length - 1);
  });
});

describe('directory filters from the URL', () => {
  it('keeps only a kind the vocabulary knows and reads the archived toggle exactly', () => {
    expect(toPeopleFilters({ kind: 'student', archived: '1', page: '2' })).toMatchObject({
      kind: 'student',
      active: 'all',
      page: 2,
    });
    expect(toPeopleFilters({ kind: 'parent' }).kind).toBeUndefined();
    expect(toPeopleFilters({ archived: 'yes' }).active).toBe('true');
    expect(toPeopleFilters({ query: ['Whit', 'ignored'] }).query).toBe('Whit');
    expect(toPeopleFilters({ page: '-3' }).page).toBe(1);
  });
});

describe('describeFieldList', () => {
  it('reads a created or updated event\'s column list in plain words', async () => {
    const { describeFieldList } = await import('../src/lib/domain/records');
    expect(describeFieldList('kind, first_name, osis, school_dbn')).toBe(
      'kind, first name, OSIS, school DBN',
    );
    expect(describeFieldList('asset_tag, os')).toBe('asset tag, OS');
  });

  it('leaves any other detail as written', async () => {
    const { describeFieldList } = await import('../src/lib/domain/records');
    expect(describeFieldList('Charger missing; screen scratched')).toBeNull();
    expect(describeFieldList(null)).toBeNull();
    expect(describeFieldList('')).toBeNull();
  });
});

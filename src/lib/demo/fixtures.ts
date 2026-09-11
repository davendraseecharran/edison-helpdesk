/**
 * Synthetic demo dataset.
 *
 * Everything here is invented. No name, email address, room number, serial
 * number, asset tag or identifier comes from the school's real spreadsheet,
 * directory or inventory, and nothing in this file may be replaced with real
 * records — importing live data is an M4 task with its own review.
 *
 * Email addresses use the reserved `example` TLD so they cannot resolve.
 *
 * The dataset is generated relative to the current date (fixed times of day) so
 * the prototype always looks like a live school day. It is built on the client
 * after mount, which is also why the app never has to match a server-rendered
 * clock.
 */

import type {
  Account,
  ActivityEvent,
  DeviceObservation,
  HelpdeskData,
  Requester,
  Ticket,
  WorkLog,
  WorkNote,
} from '../domain/types';
import { SCHOOL_TIME_ZONE, toDateKey } from '../format';

export const DEMO_ACCOUNT_IDS = {
  admin: 'acct_admin',
  priya: 'acct_priya',
  dev: 'acct_dev',
  sam: 'acct_sam',
  jordan: 'acct_jordan',
  alex: 'acct_alex',
} as const;

const schoolOffset = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHOOL_TIME_ZONE, timeZoneName: 'longOffset',
});

/** Fixed school-day fixture times, independent of the viewer's timezone.
 * Fixture hours are daytime, outside daylight-saving transition ambiguity. */
function at(base: Date, dayOffset: number, hours: number, minutes: number): string {
  const day = dayKey(base, dayOffset);
  const noon = new Date(`${day}T12:00:00Z`);
  const offset = schoolOffset.formatToParts(noon)
    .find((part) => part.type === 'timeZoneName')!.value.replace('GMT', '');
  return new Date(`${day}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00${offset}`).toISOString();
}

function dayKey(base: Date, dayOffset: number): string {
  const date = new Date(`${toDateKey(base)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

export function createDemoData(now: Date = new Date()): HelpdeskData {
  const today = dayKey(now, 0);
  const yesterday = dayKey(now, -1);
  const twoDaysAgo = dayKey(now, -2);

  const accounts: Account[] = [
    {
      id: DEMO_ACCOUNT_IDS.admin,
      displayName: 'Morgan Ellis',
      email: 'morgan.ellis@edison.example',
      role: 'admin',
      status: 'active',
      createdAt: at(now, -60, 8, 0),
      lastCredentialActionAt: null,
      lastCredentialActionKind: null,
    },
    {
      id: DEMO_ACCOUNT_IDS.priya,
      displayName: 'Priya Raman',
      email: 'priya.raman@edison.example',
      role: 'technician',
      status: 'active',
      createdAt: at(now, -45, 8, 10),
      lastCredentialActionAt: at(now, -45, 8, 20),
      lastCredentialActionKind: 'setup_issued',
    },
    {
      id: DEMO_ACCOUNT_IDS.dev,
      displayName: 'Dev Okafor',
      email: 'dev.okafor@edison.example',
      role: 'technician',
      status: 'active',
      createdAt: at(now, -45, 8, 12),
      lastCredentialActionAt: at(now, -45, 8, 25),
      lastCredentialActionKind: 'setup_issued',
    },
    {
      id: DEMO_ACCOUNT_IDS.sam,
      displayName: 'Sam Whitaker',
      email: 'sam.whitaker@edison.example',
      role: 'technician',
      status: 'active',
      createdAt: at(now, -30, 9, 5),
      lastCredentialActionAt: at(now, -30, 9, 15),
      lastCredentialActionKind: 'setup_issued',
    },
    {
      id: DEMO_ACCOUNT_IDS.jordan,
      displayName: 'Jordan Pike',
      email: 'jordan.pike@edison.example',
      role: 'technician',
      // Created by the admin but has not chosen a password yet.
      status: 'setup_pending',
      createdAt: at(now, -1, 15, 40),
      lastCredentialActionAt: at(now, -1, 15, 45),
      lastCredentialActionKind: 'setup_issued',
    },
    {
      id: DEMO_ACCOUNT_IDS.alex,
      displayName: 'Alex Reyes',
      email: 'alex.reyes@edison.example',
      role: 'technician',
      // Left the team; history stays attributed to them.
      status: 'inactive',
      createdAt: at(now, -300, 8, 0),
      lastCredentialActionAt: at(now, -120, 11, 0),
      lastCredentialActionKind: 'recovery_issued',
    },
  ];

  const requesters: Requester[] = [
    { id: 'req_calloway', displayName: 'Ms. Calloway', kind: 'staff', descriptor: 'Grade 6 ELA' },
    { id: 'req_benitez', displayName: 'Mr. Benitez', kind: 'staff', descriptor: 'Facilities' },
    { id: 'req_front_office', displayName: 'Front Office', kind: 'role', descriptor: 'Main office desk' },
    { id: 'req_hale', displayName: 'Dr. Hale', kind: 'staff', descriptor: 'Science department' },
    { id: 'req_chen', displayName: 'Riley Chen', kind: 'student', descriptor: 'Grade 9' },
    { id: 'req_osei', displayName: 'Mr. Osei', kind: 'staff', descriptor: 'Athletics' },
  ];

  const tickets: Ticket[] = [
    // --- Open Queue: unassigned, claimable by any technician ---
    {
      id: 'tkt_1001',
      number: 'EDT-1001',
      title: 'Projector in Room 212 will not display',
      issue:
        'Teacher reports the ceiling projector powers on but shows "no signal" from the podium laptop. Worked yesterday afternoon.',
      requesterId: 'req_calloway',
      requesterUnknown: false,
      location: 'Room 212',
      isRemote: false,
      channel: 'phone_call',
      priority: 'high',
      status: 'open',
      submittedOn: today,
      createdAt: at(now, 0, 7, 52),
      createdById: DEMO_ACCOUNT_IDS.admin,
      ownerId: null,
      collaboratorIds: [],
      assignedAt: null,
      waitingReason: null,
      solution: null,
      resolvedById: null,
      resolvedAt: null,
      cancelReason: null,
    },
    {
      id: 'tkt_1002',
      number: 'EDT-1002',
      title: 'Chromebook cart not charging',
      issue:
        'Cart 4 in the library is not charging any of the devices on the left bank. Power strip light is on.',
      requesterId: 'req_benitez',
      requesterUnknown: false,
      location: 'Library',
      isRemote: false,
      channel: 'walk_in',
      priority: 'normal',
      status: 'open',
      submittedOn: today,
      createdAt: at(now, 0, 8, 15),
      createdById: DEMO_ACCOUNT_IDS.admin,
      ownerId: null,
      collaboratorIds: [],
      assignedAt: null,
      waitingReason: null,
      solution: null,
      resolvedById: null,
      resolvedAt: null,
      cancelReason: null,
    },
    {
      id: 'tkt_1003',
      number: 'EDT-1003',
      title: 'Main office phone line and network drop are down',
      issue:
        'No dial tone at the front desk and the desktop shows no network. Room-wide fault, no single device involved.',
      requesterId: 'req_front_office',
      requesterUnknown: false,
      location: 'Main Office',
      isRemote: false,
      channel: 'phone_call',
      priority: 'urgent',
      status: 'open',
      submittedOn: today,
      createdAt: at(now, 0, 8, 34),
      createdById: DEMO_ACCOUNT_IDS.admin,
      ownerId: null,
      collaboratorIds: [],
      assignedAt: null,
      waitingReason: null,
      solution: null,
      resolvedById: null,
      resolvedAt: null,
      cancelReason: null,
    },

    // --- Assigned to Priya, untouched so far ---
    {
      id: 'tkt_1004',
      number: 'EDT-1004',
      title: 'Staff laptop will not join the staff Wi-Fi network',
      issue:
        'Laptop connects to the guest network but fails authentication on staff Wi-Fi since the weekend.',
      requesterId: 'req_hale',
      requesterUnknown: false,
      location: 'Room 118',
      isRemote: false,
      channel: 'email',
      priority: 'normal',
      status: 'assigned',
      submittedOn: today,
      createdAt: at(now, 0, 8, 5),
      createdById: DEMO_ACCOUNT_IDS.admin,
      ownerId: DEMO_ACCOUNT_IDS.priya,
      collaboratorIds: [],
      assignedAt: at(now, 0, 8, 6),
      waitingReason: null,
      solution: null,
      resolvedById: null,
      resolvedAt: null,
      cancelReason: null,
    },

    // --- In progress, multi-device, owner + collaborator, time logged by both ---
    {
      id: 'tkt_1005',
      number: 'EDT-1005',
      title: 'Three laptops in Lab B fail to boot after the update',
      issue:
        "Three student laptops stop at the recovery screen after last night's update. Class needs them by sixth period.",
      requesterId: 'req_chen',
      requesterUnknown: false,
      location: 'Lab B',
      isRemote: false,
      channel: 'walk_in',
      priority: 'high',
      status: 'in_progress',
      submittedOn: today,
      createdAt: at(now, 0, 8, 40),
      createdById: DEMO_ACCOUNT_IDS.priya,
      ownerId: DEMO_ACCOUNT_IDS.priya,
      collaboratorIds: [DEMO_ACCOUNT_IDS.dev],
      assignedAt: at(now, 0, 8, 40),
      waitingReason: null,
      solution: null,
      resolvedById: null,
      resolvedAt: null,
      cancelReason: null,
    },

    // --- Waiting on parts: owner Dev, collaborator Priya ---
    {
      id: 'tkt_1006',
      number: 'EDT-1006',
      title: 'Interactive panel pen not tracking',
      issue:
        'Pen input is offset by several centimetres on the interactive panel. Recalibration did not help.',
      requesterId: 'req_osei',
      requesterUnknown: false,
      location: 'Gym office',
      isRemote: false,
      channel: 'walk_in',
      priority: 'normal',
      status: 'waiting',
      submittedOn: yesterday,
      createdAt: at(now, -1, 13, 20),
      createdById: DEMO_ACCOUNT_IDS.dev,
      ownerId: DEMO_ACCOUNT_IDS.dev,
      collaboratorIds: [DEMO_ACCOUNT_IDS.priya],
      assignedAt: at(now, -1, 13, 20),
      waitingReason: 'Awaiting parts — replacement pen ordered',
      solution: null,
      resolvedById: null,
      resolvedAt: null,
      cancelReason: null,
    },

    // --- Unknown requester, unknown location, self-recorded walk-in ---
    {
      id: 'tkt_1007',
      number: 'EDT-1007',
      title: 'Unlabelled tablet left at the help desk',
      issue:
        'Tablet dropped off without a name. Screen is cracked and it will not power on. Holding for identification.',
      requesterId: null,
      requesterUnknown: true,
      location: null,
      isRemote: false,
      channel: 'walk_in',
      priority: 'low',
      status: 'in_progress',
      submittedOn: yesterday,
      createdAt: at(now, -1, 14, 55),
      createdById: DEMO_ACCOUNT_IDS.priya,
      ownerId: DEMO_ACCOUNT_IDS.priya,
      collaboratorIds: [],
      assignedAt: at(now, -1, 14, 55),
      waitingReason: null,
      solution: null,
      resolvedById: null,
      resolvedAt: null,
      cancelReason: null,
    },

    // --- Resolved by a COLLABORATOR while the primary owner is preserved ---
    {
      id: 'tkt_1008',
      number: 'EDT-1008',
      title: 'Grade book will not load on classroom desktop',
      issue:
        'Browser shows a certificate warning and the grade book never finishes loading on the classroom desktop.',
      requesterId: 'req_calloway',
      requesterUnknown: false,
      location: 'Room 212',
      isRemote: false,
      channel: 'email',
      priority: 'normal',
      status: 'resolved',
      submittedOn: yesterday,
      createdAt: at(now, -1, 9, 10),
      createdById: DEMO_ACCOUNT_IDS.admin,
      ownerId: DEMO_ACCOUNT_IDS.priya,
      collaboratorIds: [DEMO_ACCOUNT_IDS.dev],
      assignedAt: at(now, -1, 9, 25),
      waitingReason: null,
      solution:
        'Cleared the stale certificate store and reinstalled the district root certificate. Grade book loads and signs in normally.',
      resolvedById: DEMO_ACCOUNT_IDS.dev,
      resolvedAt: at(now, -1, 11, 48),
      cancelReason: null,
    },

    // --- Sam's work: proves an unrelated technician's tickets stay hidden ---
    {
      id: 'tkt_1009',
      number: 'EDT-1009',
      title: 'Cafeteria point-of-sale terminal freezes at lunch',
      issue: 'Terminal 2 freezes during the first lunch period and needs a hard restart.',
      requesterId: 'req_benitez',
      requesterUnknown: false,
      location: 'Cafeteria',
      isRemote: false,
      channel: 'phone_call',
      priority: 'high',
      status: 'assigned',
      submittedOn: today,
      createdAt: at(now, 0, 7, 40),
      createdById: DEMO_ACCOUNT_IDS.admin,
      ownerId: DEMO_ACCOUNT_IDS.sam,
      collaboratorIds: [],
      assignedAt: at(now, 0, 7, 45),
      waitingReason: null,
      solution: null,
      resolvedById: null,
      resolvedAt: null,
      cancelReason: null,
    },
    {
      id: 'tkt_1010',
      number: 'EDT-1010',
      title: 'Replace failed classroom switch uplink',
      issue: 'Intermittent network drops traced to a failing uplink in the Room 104 closet.',
      requesterId: 'req_hale',
      requesterUnknown: false,
      location: 'Room 104',
      isRemote: false,
      channel: 'walk_in',
      priority: 'normal',
      status: 'resolved',
      submittedOn: twoDaysAgo,
      createdAt: at(now, -2, 10, 5),
      createdById: DEMO_ACCOUNT_IDS.sam,
      ownerId: DEMO_ACCOUNT_IDS.sam,
      collaboratorIds: [],
      assignedAt: at(now, -2, 10, 5),
      waitingReason: null,
      solution: 'Replaced the uplink module and confirmed a stable link for two hours.',
      resolvedById: DEMO_ACCOUNT_IDS.sam,
      resolvedAt: at(now, -2, 15, 30),
      cancelReason: null,
    },

    // --- Cancelled with a reason: not a resolution ---
    {
      id: 'tkt_1011',
      number: 'EDT-1011',
      title: 'Duplicate report of the Room 212 projector fault',
      issue: 'Second call about the same projector reported earlier this morning.',
      requesterId: 'req_calloway',
      requesterUnknown: false,
      location: 'Room 212',
      isRemote: false,
      channel: 'phone_call',
      priority: 'low',
      status: 'cancelled',
      submittedOn: today,
      createdAt: at(now, 0, 8, 2),
      createdById: DEMO_ACCOUNT_IDS.admin,
      ownerId: null,
      collaboratorIds: [],
      assignedAt: null,
      waitingReason: null,
      solution: null,
      resolvedById: null,
      resolvedAt: null,
      cancelReason: 'Duplicate of EDT-1001 — same projector, same requester.',
    },
  ];

  const deviceObservations: DeviceObservation[] = [
    {
      id: 'dev_1',
      ticketId: 'tkt_1004',
      deviceType: 'Laptop',
      model: 'Dell Latitude 3440',
      osVersion: 'Windows 11 23H2',
      serialNumber: 'SYNTH-LAT-0007',
      assetTag: 'DEMO-004812',
      identifiersNotApplicable: false,
      recordedById: DEMO_ACCOUNT_IDS.admin,
      recordedAt: at(now, 0, 8, 5),
    },
    {
      id: 'dev_2',
      ticketId: 'tkt_1005',
      deviceType: 'Laptop',
      model: 'Lenovo 300w',
      osVersion: 'Windows 11 23H2',
      serialNumber: 'SYNTH-300W-0141',
      assetTag: 'DEMO-011204',
      identifiersNotApplicable: false,
      recordedById: DEMO_ACCOUNT_IDS.priya,
      recordedAt: at(now, 0, 8, 52),
    },
    {
      id: 'dev_3',
      ticketId: 'tkt_1005',
      deviceType: 'Laptop',
      model: 'Lenovo 300w',
      osVersion: 'Windows 11 23H2',
      serialNumber: 'SYNTH-300W-0142',
      assetTag: 'DEMO-011205',
      identifiersNotApplicable: false,
      recordedById: DEMO_ACCOUNT_IDS.priya,
      recordedAt: at(now, 0, 8, 53),
    },
    {
      id: 'dev_4',
      ticketId: 'tkt_1005',
      deviceType: 'Laptop',
      model: 'Lenovo 300w',
      // Unknown identifiers must never block recording the device.
      osVersion: null,
      serialNumber: null,
      assetTag: 'DEMO-011206',
      identifiersNotApplicable: false,
      recordedById: DEMO_ACCOUNT_IDS.dev,
      recordedAt: at(now, 0, 9, 30),
    },
    {
      id: 'dev_5',
      ticketId: 'tkt_1006',
      deviceType: 'Interactive panel',
      model: 'Promethean ActivPanel 9',
      osVersion: 'Firmware 4.2',
      serialNumber: null,
      assetTag: 'DEMO-007730',
      identifiersNotApplicable: false,
      recordedById: DEMO_ACCOUNT_IDS.dev,
      recordedAt: at(now, -1, 13, 35),
    },
    {
      id: 'dev_6',
      ticketId: 'tkt_1007',
      deviceType: 'Tablet',
      model: 'Unknown — no visible branding',
      osVersion: null,
      // Explicitly not applicable: nothing legible on the casing.
      serialNumber: null,
      assetTag: null,
      identifiersNotApplicable: true,
      recordedById: DEMO_ACCOUNT_IDS.priya,
      recordedAt: at(now, -1, 15, 0),
    },
    {
      id: 'dev_7',
      ticketId: 'tkt_1008',
      deviceType: 'Desktop',
      model: 'HP ProDesk 400 G9',
      osVersion: 'Windows 11 23H2',
      serialNumber: 'SYNTH-PD400-0088',
      assetTag: 'DEMO-002198',
      identifiersNotApplicable: false,
      recordedById: DEMO_ACCOUNT_IDS.priya,
      recordedAt: at(now, -1, 9, 40),
    },
  ];

  const notes: WorkNote[] = [
    {
      id: 'note_1',
      ticketId: 'tkt_1005',
      authorId: DEMO_ACCOUNT_IDS.priya,
      body: 'Two of the three laptops reach the recovery screen. Trying the rollback option on the first unit now.',
      createdAt: at(now, 0, 8, 55),
    },
    {
      id: 'note_2',
      ticketId: 'tkt_1005',
      authorId: DEMO_ACCOUNT_IDS.dev,
      body: 'Took the third laptop. Rollback finished on mine; imaging is the faster path if the rollback fails again.',
      createdAt: at(now, 0, 9, 35),
    },
    {
      id: 'note_3',
      ticketId: 'tkt_1006',
      authorId: DEMO_ACCOUNT_IDS.dev,
      body: 'Calibration utility completes but the offset returns after a restart. Digitiser looks faulty; ordering a replacement pen.',
      createdAt: at(now, -1, 13, 50),
    },
    {
      id: 'note_4',
      ticketId: 'tkt_1006',
      authorId: DEMO_ACCOUNT_IDS.priya,
      body: 'Confirmed the same offset with a spare pen, so the panel digitiser is the likely cause rather than the pen itself.',
      createdAt: at(now, -1, 16, 5),
    },
    {
      id: 'note_5',
      ticketId: 'tkt_1008',
      authorId: DEMO_ACCOUNT_IDS.priya,
      body: 'Certificate warning points at the local certificate store rather than the grade book itself.',
      createdAt: at(now, -1, 10, 15),
    },
    {
      id: 'note_6',
      ticketId: 'tkt_1008',
      authorId: DEMO_ACCOUNT_IDS.dev,
      body: 'Picked this up while Priya was in Lab B. Reinstalling the district root certificate cleared the warning.',
      createdAt: at(now, -1, 11, 40),
    },
    {
      id: 'note_7',
      ticketId: 'tkt_1007',
      authorId: DEMO_ACCOUNT_IDS.priya,
      body: 'No asset tag or serial visible. Holding at the help desk for a week before sending to e-waste review.',
      createdAt: at(now, -1, 15, 10),
    },
  ];

  // Person-time demo: EDT-1005 has entries from two technicians; EDT-1010 has
  // none, which must read as "not recorded" rather than zero minutes.
  const workLogs: WorkLog[] = [
    {
      id: 'log_1',
      ticketId: 'tkt_1005',
      contributorId: DEMO_ACCOUNT_IDS.priya,
      workDate: today,
      minutes: 35,
      description: 'Rollback attempts on two laptops',
      createdAt: at(now, 0, 9, 20),
    },
    {
      id: 'log_2',
      ticketId: 'tkt_1005',
      contributorId: DEMO_ACCOUNT_IDS.dev,
      workDate: today,
      minutes: 25,
      description: 'Third laptop rollback and verification',
      createdAt: at(now, 0, 9, 40),
    },
    {
      id: 'log_3',
      ticketId: 'tkt_1008',
      contributorId: DEMO_ACCOUNT_IDS.dev,
      workDate: yesterday,
      minutes: 20,
      description: 'Certificate store repair',
      createdAt: at(now, -1, 11, 50),
    },
    {
      id: 'log_4',
      ticketId: 'tkt_1006',
      contributorId: DEMO_ACCOUNT_IDS.dev,
      workDate: yesterday,
      minutes: 40,
      description: 'Calibration testing and vendor lookup',
      createdAt: at(now, -1, 14, 0),
    },
  ];

  const activity: ActivityEvent[] = [];
  let eventCounter = 0;
  const event = (
    ticketId: string,
    kind: ActivityEvent['kind'],
    actorId: string,
    iso: string,
    summary: string,
    detail: string | null = null,
  ): void => {
    eventCounter += 1;
    activity.push({
      id: `evt_seed_${eventCounter}`,
      ticketId,
      kind,
      actorId,
      at: iso,
      summary,
      detail,
    });
  };

  event('tkt_1001', 'created', DEMO_ACCOUNT_IDS.admin, at(now, 0, 7, 52), 'Morgan Ellis recorded a phone call request');
  event('tkt_1002', 'created', DEMO_ACCOUNT_IDS.admin, at(now, 0, 8, 15), 'Morgan Ellis recorded a walk-in request');
  event('tkt_1003', 'created', DEMO_ACCOUNT_IDS.admin, at(now, 0, 8, 34), 'Morgan Ellis recorded a phone call request');
  event('tkt_1003', 'priority_changed', DEMO_ACCOUNT_IDS.admin, at(now, 0, 8, 36), 'Morgan Ellis changed priority from Normal to Urgent');

  event('tkt_1004', 'created', DEMO_ACCOUNT_IDS.admin, at(now, 0, 8, 5), 'Morgan Ellis recorded an email request');
  event('tkt_1004', 'device_recorded', DEMO_ACCOUNT_IDS.admin, at(now, 0, 8, 5), 'Morgan Ellis recorded a device: Laptop');
  event('tkt_1004', 'assigned', DEMO_ACCOUNT_IDS.admin, at(now, 0, 8, 6), 'Morgan Ellis assigned the ticket to Priya Raman');

  event('tkt_1005', 'created', DEMO_ACCOUNT_IDS.priya, at(now, 0, 8, 40), 'Priya Raman recorded a walk-in request');
  event('tkt_1005', 'assigned', DEMO_ACCOUNT_IDS.priya, at(now, 0, 8, 40), 'Priya Raman took ownership at intake');
  event('tkt_1005', 'device_recorded', DEMO_ACCOUNT_IDS.priya, at(now, 0, 8, 52), 'Priya Raman recorded a device: Laptop');
  event('tkt_1005', 'device_recorded', DEMO_ACCOUNT_IDS.priya, at(now, 0, 8, 53), 'Priya Raman recorded a device: Laptop');
  event('tkt_1005', 'note_added', DEMO_ACCOUNT_IDS.priya, at(now, 0, 8, 55), 'Priya Raman added a work note', notes[0]?.body ?? null);
  event('tkt_1005', 'status_changed', DEMO_ACCOUNT_IDS.priya, at(now, 0, 8, 55), 'Priya Raman started work');
  event('tkt_1005', 'collaborator_added', DEMO_ACCOUNT_IDS.priya, at(now, 0, 9, 25), 'Priya Raman added Dev Okafor as a collaborator');
  event('tkt_1005', 'device_recorded', DEMO_ACCOUNT_IDS.dev, at(now, 0, 9, 30), 'Dev Okafor recorded a device: Laptop');
  event('tkt_1005', 'note_added', DEMO_ACCOUNT_IDS.dev, at(now, 0, 9, 35), 'Dev Okafor added a work note', notes[1]?.body ?? null);
  event('tkt_1005', 'time_logged', DEMO_ACCOUNT_IDS.priya, at(now, 0, 9, 20), 'Priya Raman logged 35 minutes', 'Rollback attempts on two laptops');
  event('tkt_1005', 'time_logged', DEMO_ACCOUNT_IDS.dev, at(now, 0, 9, 40), 'Dev Okafor logged 25 minutes', 'Third laptop rollback and verification');

  event('tkt_1006', 'created', DEMO_ACCOUNT_IDS.dev, at(now, -1, 13, 20), 'Dev Okafor recorded a walk-in request');
  event('tkt_1006', 'assigned', DEMO_ACCOUNT_IDS.dev, at(now, -1, 13, 20), 'Dev Okafor took ownership at intake');
  event('tkt_1006', 'device_recorded', DEMO_ACCOUNT_IDS.dev, at(now, -1, 13, 35), 'Dev Okafor recorded a device: Interactive panel');
  event('tkt_1006', 'note_added', DEMO_ACCOUNT_IDS.dev, at(now, -1, 13, 50), 'Dev Okafor added a work note', notes[2]?.body ?? null);
  event('tkt_1006', 'time_logged', DEMO_ACCOUNT_IDS.dev, at(now, -1, 14, 0), 'Dev Okafor logged 40 minutes', 'Calibration testing and vendor lookup');
  event('tkt_1006', 'collaborator_added', DEMO_ACCOUNT_IDS.dev, at(now, -1, 15, 55), 'Dev Okafor added Priya Raman as a collaborator');
  event('tkt_1006', 'note_added', DEMO_ACCOUNT_IDS.priya, at(now, -1, 16, 5), 'Priya Raman added a work note', notes[3]?.body ?? null);
  event('tkt_1006', 'status_changed', DEMO_ACCOUNT_IDS.dev, at(now, -1, 16, 30), 'Dev Okafor set the ticket to Waiting', 'Awaiting parts — replacement pen ordered');

  event('tkt_1007', 'created', DEMO_ACCOUNT_IDS.priya, at(now, -1, 14, 55), 'Priya Raman recorded a walk-in request');
  event('tkt_1007', 'assigned', DEMO_ACCOUNT_IDS.priya, at(now, -1, 14, 55), 'Priya Raman took ownership at intake');
  event('tkt_1007', 'device_recorded', DEMO_ACCOUNT_IDS.priya, at(now, -1, 15, 0), 'Priya Raman recorded a device: Tablet');
  event('tkt_1007', 'note_added', DEMO_ACCOUNT_IDS.priya, at(now, -1, 15, 10), 'Priya Raman added a work note', notes[6]?.body ?? null);
  event('tkt_1007', 'status_changed', DEMO_ACCOUNT_IDS.priya, at(now, -1, 15, 10), 'Priya Raman started work');

  event('tkt_1008', 'created', DEMO_ACCOUNT_IDS.admin, at(now, -1, 9, 10), 'Morgan Ellis recorded an email request');
  event('tkt_1008', 'assigned', DEMO_ACCOUNT_IDS.admin, at(now, -1, 9, 25), 'Morgan Ellis assigned the ticket to Priya Raman');
  event('tkt_1008', 'device_recorded', DEMO_ACCOUNT_IDS.priya, at(now, -1, 9, 40), 'Priya Raman recorded a device: Desktop');
  event('tkt_1008', 'note_added', DEMO_ACCOUNT_IDS.priya, at(now, -1, 10, 15), 'Priya Raman added a work note', notes[4]?.body ?? null);
  event('tkt_1008', 'status_changed', DEMO_ACCOUNT_IDS.priya, at(now, -1, 10, 15), 'Priya Raman started work');
  event('tkt_1008', 'collaborator_added', DEMO_ACCOUNT_IDS.priya, at(now, -1, 11, 30), 'Priya Raman added Dev Okafor as a collaborator');
  event('tkt_1008', 'note_added', DEMO_ACCOUNT_IDS.dev, at(now, -1, 11, 40), 'Dev Okafor added a work note', notes[5]?.body ?? null);
  event('tkt_1008', 'time_logged', DEMO_ACCOUNT_IDS.dev, at(now, -1, 11, 50), 'Dev Okafor logged 20 minutes', 'Certificate store repair');
  event(
    'tkt_1008',
    'resolved',
    DEMO_ACCOUNT_IDS.dev,
    at(now, -1, 11, 48),
    'Dev Okafor resolved the ticket (owner Priya Raman)',
    'Cleared the stale certificate store and reinstalled the district root certificate. Grade book loads and signs in normally.',
  );

  event('tkt_1009', 'created', DEMO_ACCOUNT_IDS.admin, at(now, 0, 7, 40), 'Morgan Ellis recorded a phone call request');
  event('tkt_1009', 'assigned', DEMO_ACCOUNT_IDS.admin, at(now, 0, 7, 45), 'Morgan Ellis assigned the ticket to Sam Whitaker');

  event('tkt_1010', 'created', DEMO_ACCOUNT_IDS.sam, at(now, -2, 10, 5), 'Sam Whitaker recorded a walk-in request');
  event('tkt_1010', 'assigned', DEMO_ACCOUNT_IDS.sam, at(now, -2, 10, 5), 'Sam Whitaker took ownership at intake');
  event(
    'tkt_1010',
    'resolved',
    DEMO_ACCOUNT_IDS.sam,
    at(now, -2, 15, 30),
    'Sam Whitaker resolved the ticket',
    'Replaced the uplink module and confirmed a stable link for two hours.',
  );

  event('tkt_1011', 'created', DEMO_ACCOUNT_IDS.admin, at(now, 0, 8, 2), 'Morgan Ellis recorded a phone call request');
  event(
    'tkt_1011',
    'cancelled',
    DEMO_ACCOUNT_IDS.admin,
    at(now, 0, 8, 3),
    'Morgan Ellis cancelled the ticket',
    'Duplicate of EDT-1001 — same projector, same requester.',
  );

  return {
    accounts,
    requesters,
    tickets,
    deviceObservations,
    notes,
    workLogs,
    activity: activity.sort((a, b) => a.at.localeCompare(b.at)),
    sequences: {
      // Next created ticket becomes EDT-1012.
      ticketNumber: 1011,
      // Starts above every seeded id suffix so generated ids cannot collide.
      entity: 2000,
    },
  };
}

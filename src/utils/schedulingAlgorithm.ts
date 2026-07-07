import { Nurse, DayRequest, SchedulingConfig, DailySchedule, DutyCode, StaffingRequirement } from '../types';

// Helper to get number of days in a month
export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

// Helper to check if a date is weekend
export function isWeekendDay(year: number, month: number, day: number): boolean {
  const date = new Date(year, month, day);
  const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
  return dayOfWeek === 0 || dayOfWeek === 6;
}

// Helper to get day of week string
export function getDayOfWeekStr(year: number, month: number, day: number): string {
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return days[new Date(year, month, day).getDay()];
}

// Helper to shuffle array
function shuffleArray<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Helper to validate a single nurse's complete monthly schedule against all hard rules
export function validateSingleNurseSchedule(
  nurse: Nurse,
  nurseHistory: Record<number, DutyCode>,
  numDays: number,
  config: SchedulingConfig
): boolean {
  const maxConsecutiveNights = config.maxConsecutiveNights;
  const postNightOffs = config.postNightOffs;
  const maxConsecutiveWorkDays = config.maxConsecutiveWorkDays || 5;

  for (let d = 1; d <= numDays; d++) {
    const shift = nurseHistory[d];
    if (!shift) continue;

    // 1. Allowed duty check
    if (shift !== 'O' && shift !== 'W') {
      if (!nurse.allowedDuties.includes(shift)) {
        return false;
      }
    }

    // 2. W-W check
    if (shift === 'W' && d - 1 >= 1 && nurseHistory[d - 1] === 'W') {
      return false;
    }

    // 3. N-D or N-E check
    if (d - 1 >= 1 && nurseHistory[d - 1] === 'N') {
      if (shift === 'D' || shift === 'E') {
        return false;
      }
    }

    // 4. E-O-D check (N-O-D is now a soft constraint, so removed from hard ban)
    if (shift === 'D' && d - 1 >= 1 && nurseHistory[d - 1] === 'O') {
      if (d - 2 >= 1 && nurseHistory[d - 2] === 'E') {
        return false;
      }
    }

    // 5. Max consecutive night shifts check
    if (shift === 'N') {
      let consecutiveNights = 1;
      for (let k = d - 1; k >= 1; k--) {
        if (nurseHistory[k] === 'N') {
          consecutiveNights++;
        } else {
          break;
        }
      }
      if (consecutiveNights > maxConsecutiveNights) {
        return false;
      }
    }

    // 6. Max consecutive work days check
    if (shift !== 'O') {
      let consecutiveWorkDays = 1;
      for (let k = d - 1; k >= 1; k--) {
        if (nurseHistory[k] && nurseHistory[k] !== 'O') {
          consecutiveWorkDays++;
        } else {
          break;
        }
      }
      if (consecutiveWorkDays > maxConsecutiveWorkDays) {
        return false;
      }
    }
  }

  // 7. Post-Night Off Guarantee check
  let k = 1;
  while (k <= numDays) {
    if (nurseHistory[k] === 'N') {
      let blockStart = k;
      while (k <= numDays && nurseHistory[k] === 'N') {
        k++;
      }
      let blockEnd = k - 1;
      let blockLength = blockEnd - blockStart + 1;
      if (blockLength >= 1) {
        for (let offset = 1; offset <= postNightOffs; offset++) {
          const offDay = blockEnd + offset;
          if (offDay <= numDays) {
            const offDayShift = nurseHistory[offDay];
            if (offDayShift && offDayShift !== 'O') {
              return false;
            }
          }
        }
      }
    } else {
      k++;
    }
  }

  return true;
}

function generateSingleTrial(
  nurses: Nurse[],
  requests: DayRequest[],
  config: SchedulingConfig
): { days: DailySchedule[]; validationAlerts: string[] } {
  const { year, month, weekdaysRequirement, weekendsRequirement, maxConsecutiveNights, postNightOffs, targetOffDays } = config;
  const numDays = getDaysInMonth(year, month);
  const alerts: string[] = [];

  // Initialize history tracker: nurseId -> array of assignments (1-indexed for day)
  const history: Record<string, Record<number, DutyCode>> = {};
  nurses.forEach((n) => {
    history[n.id] = {};
  });

  // Daily schedules list
  const dailySchedules: DailySchedule[] = [];

  // Iterate day by day from 1 to numDays
  for (let d = 1; d <= numDays; d++) {
    const isWeekend = isWeekendDay(year, month, d);
    const dayOfWeek = getDayOfWeekStr(year, month, d);
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    // Get requirement for today
    const req = isWeekend ? weekendsRequirement : weekdaysRequirement;

    // Filter requests for today
    const dailyRequests = requests.filter((r) => r.day === d);

    // Initial assignments for today
    const assignments: Record<string, DutyCode> = {};
    const assignedNurses = new Set<string>();

    // 1. First, apply user requests from the interactive calendar
    dailyRequests.forEach((reqItem) => {
      // Find the nurse in current nurses list (might have been removed)
      const nurseExists = nurses.some((n) => n.id === reqItem.nurseId);
      if (nurseExists) {
        assignments[reqItem.nurseId] = reqItem.duty;
        assignedNurses.add(reqItem.nurseId);
      }
    });

    // Helper to check eligibility for an active shift
    const checkEligibility = (nurse: Nurse, shift: DutyCode): { eligible: boolean; reason?: string } => {
      // 1. Already assigned?
      if (assignedNurses.has(nurse.id)) {
        return { eligible: false, reason: 'Already assigned (Request / Scheduled)' };
      }

      // 2. Allowed duty check
      if (!nurse.allowedDuties.includes(shift)) {
        return { eligible: false, reason: `Duty "${shift}" is not in allowed duties` };
      }

      // 2.2 Individual Min / Max Off days checks (Dynamic boundaries)
      if (shift !== 'O') {
        const nurseMinOff = nurse.minOffDays !== undefined ? nurse.minOffDays : targetOffDays;
        const nurseMaxOff = nurse.maxOffDays !== undefined ? nurse.maxOffDays : targetOffDays;
        const maxAllowedWorkDays = numDays - nurseMinOff;

        let offDaysSoFar = 0;
        let workDaysSoFar = 0;
        for (let k = 1; k < d; k++) {
          const s = history[nurse.id][k];
          if (s === 'O') {
            offDaysSoFar++;
          } else if (s) {
            workDaysSoFar++;
          }
        }

        const remainingDays = numDays - d + 1; // includes today

        // If giving them work today makes it impossible to meet their minimum off-days requirement
        if (offDaysSoFar + (remainingDays - 1) < nurseMinOff) {
          return { eligible: false, reason: `Must be Off today to guarantee minimum off-days (${nurseMinOff} days required, ${offDaysSoFar} had, ${remainingDays - 1} remaining after today)` };
        }

        // If they have already worked their maximum allowed working days
        if (workDaysSoFar >= maxAllowedWorkDays) {
          return { eligible: false, reason: `Cannot work today as maximum work days limit reached (to satisfy minimum off days of ${nurseMinOff})` };
        }
      }

      // 3. Yesterday checks (Day d-1)
      const yesterdayShift = d - 1 >= 1 ? history[nurse.id][d - 1] : undefined;
      if (yesterdayShift) {
        // N-D and N-E are completely banned
        if (yesterdayShift === 'N') {
          if (shift === 'D' || shift === 'E') {
            return { eligible: false, reason: `Cannot work ${shift} directly after Night shift (N-D, N-E banned)` };
          }
        }
      }

      // 4. Forbidden patterns of length 3: E-O-D is banned
      if (shift === 'D') {
        const yesterday = d - 1 >= 1 ? history[nurse.id][d - 1] : undefined;
        const dayBeforeYesterday = d - 2 >= 1 ? history[nurse.id][d - 2] : undefined;
        if (yesterday === 'O') {
          if (dayBeforeYesterday === 'E') {
            return { eligible: false, reason: 'Forbidden pattern E-O-D detected' };
          }
        }
      }

      // 5. Max consecutive night shifts control
      if (shift === 'N') {
        let consecutiveNights = 0;
        for (let k = d - 1; k >= 1; k--) {
          if (history[nurse.id][k] === 'N') {
            consecutiveNights++;
          } else {
            break;
          }
        }
        if (consecutiveNights >= maxConsecutiveNights) {
          return { eligible: false, reason: `Exceeds max consecutive night shifts (${maxConsecutiveNights})` };
        }
      }

      // 5.5 Max consecutive work days control (including double shifts)
      const maxConsecutiveWorkDays = config.maxConsecutiveWorkDays || 5;
      let consecutiveWorkDays = 0;
      for (let k = d - 1; k >= 1; k--) {
        const prevShift = history[nurse.id][k];
        if (prevShift && prevShift !== 'O') {
          consecutiveWorkDays++;
        } else {
          break;
        }
      }
      if (consecutiveWorkDays >= maxConsecutiveWorkDays) {
        return { eligible: false, reason: `Exceeds max consecutive work days (${maxConsecutiveWorkDays})` };
      }

      // 6. Post-Night Off Control:
      // If a nurse completed a Night shift (even 1 night),
      // they must get postNightOffs (1 or 2) off days immediately after.
      let lastNightDay = -1;
      for (let k = d - 1; k >= 1; k--) {
        const s = history[nurse.id][k];
        if (s === 'N') {
          lastNightDay = k;
          break;
        } else if (s && s !== 'O') {
          break;
        }
      }

      if (lastNightDay !== -1) {
        // The rest period should have length `postNightOffs`.
        // If the current day is within this rest period, they MUST be Off, unless they are continuing the night block directly.
        const inRestPeriod = (d <= lastNightDay + postNightOffs);
        if (inRestPeriod) {
          const isContinuingNightBlock = (shift === 'N' && lastNightDay === d - 1);
          if (!isContinuingNightBlock) {
            return { eligible: false, reason: `Mandatory post-night off rest period (${d - 1 - lastNightDay}/${postNightOffs} days completed)` };
          }
        }
      }

      return { eligible: true };
    };

    // Calculate current counts from pre-assignments (requests)
    const currentCounts = { D: 0, E: 0, N: 0, O: 0, W: 0 };
    Object.keys(assignments).forEach((nurseId) => {
      const code = assignments[nurseId];
      currentCounts[code]++;
    });

    // Remainder requirements
    let remD = Math.max(0, req.D - currentCounts.D);
    let remE = Math.max(0, req.E - currentCounts.E);
    let remN = Math.max(0, req.N - currentCounts.N);

    // List of active shifts to schedule
    const shiftsToSchedule: { code: DutyCode; remaining: number }[] = [
      { code: 'N', remaining: remN }, // Schedule Night first as it is highly constrained
      { code: 'E', remaining: remE },
      { code: 'D', remaining: remD },
    ];

    // Track original assignment (before W upgrades)
    const initialDayAssignments = { ...assignments };

    // Schedule each shift
    shiftsToSchedule.forEach((shiftObj) => {
      let remaining = shiftObj.remaining;
      const shift = shiftObj.code;

      // Find eligible nurses
      let eligibleNurses = nurses.filter((n) => checkEligibility(n, shift).eligible);
      // Shuffle them to ensure randomized schedule every time "Regenerate" is run
      eligibleNurses = shuffleArray(eligibleNurses);

      // Prioritize eligible nurses to balance the workload and respect limited preferences:
      // 1. Prioritize nurses who can ONLY work this shift (e.g. night-only nurse for 'N' shift)
      // 2. Prioritize nurses who worked the same shift yesterday to encourage block scheduling (e.g., D-D-E-E rather than E-D-E-D)
      // 3. Prioritize nurses who were Off yesterday to start a block after rest
      // 4. Prioritize nurses who have been assigned fewer active (non-'O') shifts so far to balance workload
      const getWorkCount = (nurseId: string) => {
        let workDays = 0;
        for (let k = 1; k < d; k++) {
          const s = history[nurseId][k];
          if (s && s !== 'O') {
            workDays++;
          }
        }
        return workDays;
      };

      const getPriorityScore = (nurse: Nurse) => {
        let score = 0;

        // 1. Only-this-shift specialty bonus (highest priority, e.g. night-only nurse gets N)
        const isOnlyThis = nurse.allowedDuties.length === 1 && nurse.allowedDuties[0] === shift;
        if (isOnlyThis) {
          score += 2000;
        }

        // 2. Consecutive identical shift bonus (preferred but moderate to allow mixing D-E-N)
        const yesterdayShift = history[nurse.id][d - 1];
        if (yesterdayShift === shift) {
          score += 150; // Moderate bonus to continue the block!
        } else if (yesterdayShift === 'O' || !yesterdayShift) {
          score += 50; // Mild bonus to start a block after resting
        }

        // 3. Workload balancing & Individual off-days bounds
        const remainingDays = numDays - d + 1;
        const workDaysSoFar = getWorkCount(nurse.id);
        const offDaysSoFar = (d - 1) - workDaysSoFar;

        const nurseMinOff = nurse.minOffDays !== undefined ? nurse.minOffDays : targetOffDays;
        const nurseMaxOff = nurse.maxOffDays !== undefined ? nurse.maxOffDays : targetOffDays;

        const minRequiredWorkDays = numDays - nurseMaxOff;

        // Hard boundary buffer check: Must work to not exceed max off-days limit
        if (workDaysSoFar + remainingDays <= minRequiredWorkDays) {
          score += 10000; // Absolute highest priority to assign work
        }

        // Proactive scaling bonus as we approach maxOffDays to ensure we don't violate the limit
        const offDaysLeftToMax = nurseMaxOff - offDaysSoFar;
        if (offDaysLeftToMax <= 3) {
          score += (4 - offDaysLeftToMax) * 1500; // Large boost when 0, 1, 2, or 3 off days left to max
        }

        // Smooth priority balancing:
        // Nurses who have had fewer off-days relative to their minOffDays get lower priority for work (letting them get Offs)
        // Nurses who have had more off-days relative to their maxOffDays get higher priority for work (letting them work)
        const minOffRatio = offDaysSoFar / Math.max(1, nurseMinOff);
        const maxOffRatio = offDaysSoFar / Math.max(1, nurseMaxOff);

        score -= minOffRatio * 150; // Deprioritize if they still need off-days
        score += maxOffRatio * 150; // Prioritize if they are getting too many off-days

        // 4. Mix balancing: encourage even distribution of D, E, N for nurses who have multiple allowed duties
        if (nurse.allowedDuties.filter(ad => ad !== 'O' && ad !== 'W').length > 1) {
          let dCount = 0;
          let eCount = 0;
          let nCount = 0;
          for (let k = 1; k < d; k++) {
            const s = history[nurse.id][k];
            if (s === 'D') dCount++;
            else if (s === 'E') eCount++;
            else if (s === 'N') nCount++;
          }
          
          const totalActive = dCount + eCount + nCount;
          if (totalActive > 0) {
            const currentShiftCount = shift === 'D' ? dCount : shift === 'E' ? eCount : nCount;
            const allowedActiveDuties = nurse.allowedDuties.filter(ad => ad !== 'O' && ad !== 'W');
            const numAllowed = allowedActiveDuties.length;
            const expectedCount = totalActive / numAllowed;
            const difference = currentShiftCount - expectedCount;
            // Penalize if they've worked this shift more than expected, boost if less
            score -= difference * 100;
          }
        }

        // Minor workload adjustment - ONLY as a minor tie-breaker
        score -= workDaysSoFar * 2;

        // 4.5 Soft constraint penalty for N-O-D (Night - Off - Day)
        if (shift === 'D') {
          const yesterday = d - 1 >= 1 ? history[nurse.id][d - 1] : undefined;
          const dayBeforeYesterday = d - 2 >= 1 ? history[nurse.id][d - 2] : undefined;
          if (yesterday === 'O' && dayBeforeYesterday === 'N') {
            score -= 3000; // Heavy penalty to avoid forming N-O-D if we can find any other nurse!
          }
        }

        return score;
      };

      eligibleNurses.sort((a, b) => {
        return getPriorityScore(a) - getPriorityScore(b);
      });

      while (remaining > 0 && eligibleNurses.length > 0) {
        const selectedNurse = eligibleNurses.pop()!;
        assignments[selectedNurse.id] = shift;
        assignedNurses.add(selectedNurse.id);
        remaining--;
      }

      // If we still have remaining, we have a deficit! Let's flag this and we will apply Double Shift fallback
      shiftObj.remaining = remaining;
    });

    // 2. Double Shift Fallback Logic (Crucial)
    // If there is still a remaining deficit in Day, Evening, or Night shifts:
    let doubleShiftAssignedToday = false;

    shiftsToSchedule.forEach((shiftObj) => {
      let remaining = shiftObj.remaining;
      const shift = shiftObj.code;

      if (remaining > 0) {
        // We need to find a nurse to upgrade to Double Shift "W" to cover the gap.
        // A single nurse cannot have two consecutive Double Shifts (W-W is completely banned).
        // Forbidden patterns must still be respected.
        // Who is eligible for "W" fallback today?
        // Let's look for:
        // A) Nurses who are already assigned to an active shift today (D, E, N) and can do a double shift
        // B) Nurses who are currently unassigned (Off) but are allowed to work and can do W
        // They must NOT have worked W yesterday (d-1), and must be eligible for this deficit shift.
        
        // Find candidate nurses
        let candidates = nurses.filter((nurse) => {
          // 1. Cannot have requested Off 'O' today
          const requestToday = dailyRequests.find((r) => r.nurseId === nurse.id);
          if (requestToday && requestToday.duty === 'O') {
            return false;
          }

          // 2. W-W is completely banned (cannot work W if yesterday was W)
          const yesterdayShift = history[nurse.id][d - 1];
          if (yesterdayShift === 'W') {
            return false;
          }

          // 3. Must be eligible for this deficit shift
          // To be eligible, we temporarily bypass the "Already assigned" check to see if they satisfy other constraints
          const prevAssigned = assignedNurses.has(nurse.id);
          if (prevAssigned) {
            assignedNurses.delete(nurse.id); // temporarily remove to check eligibility
          }
          const eligibility = checkEligibility(nurse, shift);
          if (prevAssigned) {
            assignedNurses.add(nurse.id); // restore
          }

          if (!eligibility.eligible) {
            return false;
          }

          // 4. Must be allowed to work this shift according to their preferences
          if (!nurse.allowedDuties.includes(shift)) {
            return false;
          }

          return true;
        });

        // Sort candidates:
        // Prioritize nurses who are ALREADY working another shift today (they can upgrade to a Double Shift W),
        // or prioritize higher competency nurses, etc. Let's shuffle them to keep it randomized.
        candidates = shuffleArray(candidates);

        while (remaining > 0 && candidates.length > 0) {
          const candidate = candidates.pop()!;
          const currentAssignment = assignments[candidate.id];

          // Set assignment to Double Shift W
          assignments[candidate.id] = 'W';
          assignedNurses.add(candidate.id);
          doubleShiftAssignedToday = true;
          remaining--;

          // Create an alert to notify that a Double Shift was assigned
          alerts.push(
            `${d}일: ${candidate.name} 간호사에게 부족한 ${shift} 근무를 지원하기 위해 더블 근무 (D/E)가 지정되었습니다.`
          );
        }

        // If we still can't cover it:
        if (remaining > 0) {
          alerts.push(
            `${d}일: [심각] 근무자 부족! 필요한 ${shift} 근무 ${remaining}건을 지원할 수 없습니다.`
          );
        }
      }
    });

    // 2.5 Force work for nurses who MUST work today to satisfy their maxOffDays (i.e. minimum work days)
    nurses.forEach((nurse) => {
      if (assignedNurses.has(nurse.id)) return;

      const remainingDays = numDays - d + 1;
      let workDaysSoFar = 0;
      for (let k = 1; k < d; k++) {
        const s = history[nurse.id][k];
        if (s && s !== 'O') {
          workDaysSoFar++;
        }
      }

      const nurseMaxOff = nurse.maxOffDays !== undefined ? nurse.maxOffDays : targetOffDays;
      const minRequiredWorkDays = numDays - nurseMaxOff;

      if (workDaysSoFar + remainingDays <= minRequiredWorkDays) {
        // They MUST work today! Find an allowed duty that satisfies eligibility rules
        const possibleShifts = nurse.allowedDuties.filter((s) => s !== 'O' && s !== 'W');
        
        let assignedShift: DutyCode | null = null;
        for (const shift of possibleShifts) {
          const eligibility = checkEligibility(nurse, shift);
          if (eligibility.eligible) {
            assignedShift = shift;
            break;
          }
        }

        if (!assignedShift) {
          // Fallback: Bypass minor constraints to satisfy maxOffDays
          for (const shift of possibleShifts) {
            // Respect absolute medical rule: No D or E immediately after Night shift
            const yesterdayShift = history[nurse.id][d - 1];
            if (yesterdayShift === 'N' && (shift === 'D' || shift === 'E')) {
              continue;
            }
            assignedShift = shift;
            break;
          }
        }

        if (assignedShift) {
          assignments[nurse.id] = assignedShift;
          assignedNurses.add(nurse.id);
          alerts.push(
            `${d}일: ${nurse.name} 간호사는 필수 최대 휴무 제한을 준수하기 위해 근무(${assignedShift})가 배정되었습니다.`
          );
        }
      }
    });

    // 3. Assign remaining unassigned nurses to Off (O)
    nurses.forEach((nurse) => {
      if (!assignedNurses.has(nurse.id)) {
        assignments[nurse.id] = 'O';
      }
    });

    // Save assignments to history
    nurses.forEach((nurse) => {
      history[nurse.id][d] = assignments[nurse.id];
    });

    // Recalculate actual counts for this day
    const actualCounts = { D: 0, E: 0, N: 0, O: 0, W: 0 };
    Object.keys(assignments).forEach((nurseId) => {
      const code = assignments[nurseId];
      actualCounts[code]++;
    });

    // Determine if staffing requirements are met
    // A Double Shift 'W' covers multiple gaps. For calculation of whether requirements are met,
    // let's count W as helping to fulfill the active requirements.
    // If a nurse is assigned W, it can count towards both the original assigned shift or the deficit shift.
    // Let's assume any 'W' assignment helps fulfill the requirements.
    // Specifically:
    // Net Scheduled Day = counts of D + counts of W (if they were upgraded to cover a Day shift deficit)
    // To be precise, let's say the requirement is met if the sum of actual shifts + double shifts covers the requirement.
    // Let's calculate:
    const activeStaff = Object.values(assignments).filter(c => c !== 'O');
    const requirementsMet = {
      D: actualCounts.D + actualCounts.W >= req.D,
      E: actualCounts.E + actualCounts.W >= req.E,
      N: actualCounts.N + actualCounts.W >= req.N,
    };

    dailySchedules.push({
      day: d,
      dateStr,
      dayOfWeek,
      isWeekend,
      assignments,
      requirementsMet,
      requiredCounts: req,
      actualCounts,
      doubleShiftAssigned: doubleShiftAssignedToday,
    });
  }

  // --- Post-Processing Swaps to satisfy Min/Max Off Days strictly ---
  let improved = true;
  let iterations = 0;
  const maxIterations = 200;

  while (improved && iterations < maxIterations) {
    improved = false;

    // Calculate actual off-day counts for all nurses
    const getOffDaysCount = (nurseId: string) => {
      let count = 0;
      for (let day = 1; day <= numDays; day++) {
        if (history[nurseId][day] === 'O') {
          count++;
        }
      }
      return count;
    };

    // 1. Deficient Off-days adjustment: offDays < minOff
    const deficientNurse = nurses.find((n) => {
      const minOff = n.minOffDays !== undefined ? n.minOffDays : targetOffDays;
      return getOffDaysCount(n.id) < minOff;
    });

    if (deficientNurse) {
      const aId = deficientNurse.id;
      let swapFound = false;

      const daysOrder = shuffleArray(Array.from({ length: numDays }, (_, i) => i + 1));
      for (const day of daysOrder) {
        if (swapFound) break;
        const shiftA = history[aId][day];
        // We only swap standard work shifts, excluding O (already Off) and W (double shifts, to avoid breaking them)
        if (shiftA === 'O' || shiftA === 'W' || !shiftA) continue;

        // Ensure A doesn't have an interactive request on this day
        if (requests.some((r) => r.nurseId === aId && r.day === day)) continue;

        for (const nurseB of nurses) {
          if (nurseB.id === aId) continue;
          const bId = nurseB.id;

          // B must be currently assigned to O
          if (history[bId][day] !== 'O') continue;

          // Ensure B doesn't have an interactive request on this day
          if (requests.some((r) => r.nurseId === bId && r.day === day)) continue;

          // B must have room to work (meaning offDays > minOffB)
          const minOffB = nurseB.minOffDays !== undefined ? nurseB.minOffDays : targetOffDays;
          if (getOffDaysCount(bId) <= minOffB) continue;

          // Check if B is allowed to work shiftA
          if (!nurseB.allowedDuties.includes(shiftA)) continue;

          // Try swapping
          const originalA = history[aId][day];
          const originalB = history[bId][day];

          history[aId][day] = 'O';
          history[bId][day] = shiftA;

          if (
            validateSingleNurseSchedule(deficientNurse, history[aId], numDays, config) &&
            validateSingleNurseSchedule(nurseB, history[bId], numDays, config)
          ) {
            // Swap is valid! Commit to history and dailySchedules
            dailySchedules[day - 1].assignments[aId] = 'O';
            dailySchedules[day - 1].assignments[bId] = shiftA;
            swapFound = true;
            improved = true;
            break;
          } else {
            // Revert
            history[aId][day] = originalA;
            history[bId][day] = originalB;
          }
        }
      }

      if (swapFound) continue;
    }

    // 2. Excess Off-days adjustment: offDays > maxOff
    const excessNurse = nurses.find((n) => {
      const maxOff = n.maxOffDays !== undefined ? n.maxOffDays : targetOffDays;
      return getOffDaysCount(n.id) > maxOff;
    });

    if (excessNurse) {
      const aId = excessNurse.id;
      let swapFound = false;

      const daysOrder = shuffleArray(Array.from({ length: numDays }, (_, i) => i + 1));
      for (const day of daysOrder) {
        if (swapFound) break;
        const shiftA = history[aId][day];
        if (shiftA !== 'O') continue;

        // Ensure A doesn't have an interactive request on this day
        if (requests.some((r) => r.nurseId === aId && r.day === day)) continue;

        for (const nurseB of nurses) {
          if (nurseB.id === aId) continue;
          const bId = nurseB.id;

          const shiftB = history[bId][day];
          if (shiftB === 'O' || shiftB === 'W' || !shiftB) continue;

          // Ensure B doesn't have an interactive request on this day
          if (requests.some((r) => r.nurseId === bId && r.day === day)) continue;

          // B must have room to get an Off (meaning offDays < maxOffB)
          const maxOffB = nurseB.maxOffDays !== undefined ? nurseB.maxOffDays : targetOffDays;
          if (getOffDaysCount(bId) >= maxOffB) continue;

          // Check if A is allowed to work shiftB
          if (!excessNurse.allowedDuties.includes(shiftB)) continue;

          // Try swapping
          const originalA = history[aId][day];
          const originalB = history[bId][day];

          history[aId][day] = shiftB;
          history[bId][day] = 'O';

          if (
            validateSingleNurseSchedule(excessNurse, history[aId], numDays, config) &&
            validateSingleNurseSchedule(nurseB, history[bId], numDays, config)
          ) {
            // Swap is valid! Commit to history and dailySchedules
            dailySchedules[day - 1].assignments[aId] = shiftB;
            dailySchedules[day - 1].assignments[bId] = 'O';
            swapFound = true;
            improved = true;
            break;
          } else {
            // Revert
            history[aId][day] = originalA;
            history[bId][day] = originalB;
          }
        }
      }

      if (swapFound) continue;
    }

    iterations++;
  }

  // Final Validation Alert Checks
  // Let's check for any rule violations in the generated schedule to warn the manager!
  nurses.forEach((nurse) => {
    let offDaysCount = 0;
    const maxConsecutiveWorkDays = config.maxConsecutiveWorkDays || 5;

    for (let d = 1; d <= numDays; d++) {
      const shift = history[nurse.id][d];
      if (shift === 'O') {
        offDaysCount++;
      }
      
      // 1. W-W check
      if (shift === 'W' && d - 1 >= 1 && history[nurse.id][d - 1] === 'W') {
        alerts.push(`${d}일: [금지] ${nurse.name} 간호사에게 연속 더블 근무 (D/E - D/E)가 배정되었습니다!`);
      }

      // 2. N-D or N-E check
      if (d - 1 >= 1 && history[nurse.id][d - 1] === 'N') {
        if (shift === 'D' || shift === 'E') {
          const shiftKorean = shift === 'D' ? '낮' : '저녁';
          alerts.push(`${d}일: [금지] ${nurse.name} 간호사가 야간 근무(N) 바로 다음 날 ${shiftKorean} 근무를 배정받았습니다!`);
        }
      }

      // 3. E-O-D and N-O-D check
      if (shift === 'D' && d - 1 >= 1 && history[nurse.id][d - 1] === 'O') {
        if (d - 2 >= 1 && history[nurse.id][d - 2] === 'E') {
          alerts.push(`${d}일: [금지] ${nurse.name} 간호사에게 연속 근무 패턴 위반 (저녁-휴무-낮 / E-O-D)이 감지되었습니다.`);
        }
        if (d - 2 >= 1 && history[nurse.id][d - 2] === 'N') {
          alerts.push(`${d}일: [주의] ${nurse.name} 간호사에게 연속 근무 패턴 위반 (야간-휴무-낮 / N-O-D)이 감지되었습니다.`);
        }
      }

      // 4. Max consecutive night shifts check
      if (shift === 'N') {
        let consecutiveNights = 1;
        for (let k = d - 1; k >= 1; k--) {
          if (history[nurse.id][k] === 'N') {
            consecutiveNights++;
          } else {
            break;
          }
        }
        if (consecutiveNights > maxConsecutiveNights) {
          alerts.push(`${d}일: [제한초과] ${nurse.name} 간호사의 야간 근무 연속 근무 제한(${maxConsecutiveNights}일)을 초과했습니다 (현재: ${consecutiveNights}일).`);
        }
      }

      // 4.5 Max consecutive work days check
      if (shift !== 'O') {
        let consecutiveWorkDays = 1;
        for (let k = d - 1; k >= 1; k--) {
          if (history[nurse.id][k] && history[nurse.id][k] !== 'O') {
            consecutiveWorkDays++;
          } else {
            break;
          }
        }
        if (consecutiveWorkDays > maxConsecutiveWorkDays) {
          alerts.push(`${d}일: [제한초과] ${nurse.name} 간호사가 휴무 없이 연속으로 ${consecutiveWorkDays}일 근무하여 최대 연속 근무 제한(${maxConsecutiveWorkDays}일)을 초과했습니다.`);
        }
      }
    }

    // 2.5 Post-Night Off Guarantee check (Robust outside daily loop)
    // Find all consecutive night blocks (length >= 2).
    // When such a block ends at day k, then the days k+1 to k+postNightOffs must be 'O' (Off).
    let k = 1;
    while (k <= numDays) {
      if (history[nurse.id][k] === 'N') {
        let blockStart = k;
        while (k <= numDays && history[nurse.id][k] === 'N') {
          k++;
        }
        let blockEnd = k - 1;
        let blockLength = blockEnd - blockStart + 1;
        if (blockLength >= 1) {
          // Mandatory off days starting at blockEnd + 1
          for (let offset = 1; offset <= postNightOffs; offset++) {
            const offDay = blockEnd + offset;
            if (offDay <= numDays) {
              const offDayShift = history[nurse.id][offDay];
              if (offDayShift && offDayShift !== 'O') {
                alerts.push(`${offDay}일: [규칙위반] ${nurse.name} 간호사가 야간 근무(N) 종료(대역: ${blockStart}~${blockEnd}일) 후 필수 휴무(${postNightOffs}일)를 보장받지 못하고 근무(${offDayShift})가 배정되었습니다.`);
              }
            }
          }
        }
      } else {
        k++;
      }
    }

    // 5. Check target off-days per nurse (individual min/max)
    const nurseMinOff = nurse.minOffDays !== undefined ? nurse.minOffDays : targetOffDays;
    const nurseMaxOff = nurse.maxOffDays !== undefined ? nurse.maxOffDays : targetOffDays;

    if (offDaysCount < nurseMinOff) {
      alerts.push(`[규칙위반] ${nurse.name} 간호사의 월간 총 휴무(Off) 개수(${offDaysCount}일)가 필수 최소 설정치(${nurseMinOff}일)보다 부족합니다.`);
    } else if (offDaysCount > nurseMaxOff) {
      alerts.push(`[규칙위반] ${nurse.name} 간호사의 월간 총 휴무(Off) 개수(${offDaysCount}일)가 필수 최대 설정치(${nurseMaxOff}일)를 초과했습니다.`);
    }
  });

  return {
    days: dailySchedules,
    validationAlerts: Array.from(new Set(alerts)), // Deduplicate alerts
  };
}

export function generateSchedule(
  nurses: Nurse[],
  requests: DayRequest[],
  config: SchedulingConfig
): { days: DailySchedule[]; validationAlerts: string[]; success: boolean; error?: string; fulfillmentRate: number } {
  let bestDays: DailySchedule[] = [];
  let bestAlerts: string[] = [];
  let bestRate = -1;
  let bestHasMinOffViolation = true;
  let bestHasMaxOffViolation = true;
  let bestScore = -9999999;

  const numDays = getDaysInMonth(config.year, config.month);

  for (let trial = 0; trial < 100; trial++) {
    const result = generateSingleTrial(nurses, requests, config);

    // Calculate off-days and check min/max off-day violations
    const history: Record<string, Record<number, DutyCode>> = {};
    nurses.forEach((n) => {
      history[n.id] = {};
    });
    result.days.forEach((daySchedule, dIdx) => {
      const dayNum = dIdx + 1;
      nurses.forEach((n) => {
        history[n.id][dayNum] = daySchedule.assignments[n.id] || 'O';
      });
    });

    let hasMinOffViolation = false;
    let hasMaxOffViolation = false;
    nurses.forEach((nurse) => {
      let offDaysCount = 0;
      for (let d = 1; d <= numDays; d++) {
        if (history[nurse.id][d] === 'O') {
          offDaysCount++;
        }
      }
      const minOff = nurse.minOffDays !== undefined ? nurse.minOffDays : config.targetOffDays;
      const maxOff = nurse.maxOffDays !== undefined ? nurse.maxOffDays : config.targetOffDays;
      if (offDaysCount < minOff) {
        hasMinOffViolation = true;
      }
      if (offDaysCount > maxOff) {
        hasMaxOffViolation = true;
      }
    });

    // Calculate fulfillment rate (totalShortages / numDays)
    const totalShortages = result.days.filter(
      s => !s.requirementsMet.D || !s.requirementsMet.E || !s.requirementsMet.N
    ).length;
    const rate = ((numDays - totalShortages) / numDays) * 100;

    // Score this trial: min off violation is terrible (-1000000), higher rate is best, max off violation is mildly bad (-100)
    let trialScore = rate * 1000;
    if (hasMinOffViolation) trialScore -= 1000000;
    if (hasMaxOffViolation) trialScore -= 100;

    // If it perfectly satisfies both conditions (no minOff, no maxOff violation AND rate >= 90), return immediately!
    if (!hasMinOffViolation && !hasMaxOffViolation && rate >= 90) {
      return {
        days: result.days,
        validationAlerts: result.validationAlerts,
        fulfillmentRate: rate,
        success: true,
      };
    }

    // Otherwise, keep track of the "best" schedule.
    if (trialScore > bestScore) {
      bestDays = result.days;
      bestAlerts = result.validationAlerts;
      bestRate = rate;
      bestHasMinOffViolation = hasMinOffViolation;
      bestHasMaxOffViolation = hasMaxOffViolation;
      bestScore = trialScore;
    }
  }

  // If we ended up here, we could not find a schedule that meets both requirements perfectly.
  const errMsg = bestHasMinOffViolation
    ? `월간 필수 최소 휴무 제한을 만족하는 일정을 생성하지 못했습니다. (최적 일정 충족률: ${bestRate.toFixed(
        0
      )}%, 최소 휴무 부족 위반 있음)`
    : bestHasMaxOffViolation
    ? `월간 필수 최대 휴무 제한 및 90% 이상 일정 충족률을 동시에 만족하는 일정을 생성하지 못했습니다. (최적 일정 충족률: ${bestRate.toFixed(
        0
      )}%, 최대 휴무 초과 위반 있음)`
    : `일정 충족률이 90% 이상인 일정을 생성하지 못했습니다. 최대 90% 이상 충족할 수 있도록 입력을 조정하거나 간호사를 더 추가해보세요. (최적 일정 충족률: ${bestRate.toFixed(0)}%)`;

  return {
    days: bestDays,
    validationAlerts: bestAlerts,
    fulfillmentRate: bestRate,
    success: bestRate >= 90 && !bestHasMinOffViolation && !bestHasMaxOffViolation,
    error: errMsg,
  };
}

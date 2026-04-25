// Loan data — Aidvantage statement 02/22/26
const INITIAL_LOANS = [
  { id: "1-01", rate: 6.800, balance: 8185.69,  principal: 8179.60,  interest: 6.09,   program: "STAFUNSUB", date: "11/13/09" },
  { id: "1-02", rate: 5.600, balance: 5174.31,  principal: 5112.41,  interest: 61.90,  program: "DLSUB",     date: "06/09/10" },
  { id: "1-03", rate: 3.860, balance: 4981.11,  principal: 4979.01,  interest: 2.10,   program: "DLSUB",     date: "09/04/13" },
  { id: "1-04", rate: 3.860, balance: 7214.29,  principal: 7211.25,  interest: 3.04,   program: "DLUNSUB",   date: "09/04/13" },
  { id: "1-05", rate: 6.210, balance: 7454.44,  principal: 7265.89,  interest: 188.55, program: "DLUNSUB",   date: "08/27/14" },
  { id: "1-06", rate: 6.210, balance: 4770.49,  principal: 4650.01,  interest: 120.48, program: "DLUNSUB",   date: "08/27/14" },
  { id: "1-07", rate: 6.210, balance: 11876.76, principal: 11674.18, interest: 202.58, program: "DLUNSUB",   date: "01/14/15" },
  { id: "1-08", rate: 7.210, balance: 11514.46, principal: 11053.24, interest: 461.22, program: "DLGPLUS",   date: "01/28/15" },
  { id: "1-09", rate: 5.840, balance: 18418.53, principal: 18406.76, interest: 11.77,  program: "DLUNSUB",   date: "08/28/15" },
  { id: "1-10", rate: 6.840, balance: 10677.18, principal: 10336.43, interest: 340.75, program: "DLGPLUS",   date: "08/28/15" },
  { id: "1-11", rate: 5.310, balance: 16100.80, principal: 16091.45, interest: 9.35,   program: "DLUNSUB",   date: "08/26/16" },
];

const TOTAL_BALANCE = INITIAL_LOANS.reduce((s, l) => s + l.balance, 0);

// Simulation start: statement date 02/22/26 → month 1 = March 2026 payment
const SIM_START = new Date(2026, 2, 1); // March 1, 2026

function fmt(n) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function simulateMonth(loanStates, totalPayment, idrMin) {
  // Accrue monthly interest on principal only — no capitalization
  const updated = loanStates.map(l => {
    if (l.paidOff) return { ...l, monthlyAccrual: 0 };
    const mi = l.currentPrincipal * (l.rate / 100) / 12;
    return {
      ...l,
      accruedInterest: l.accruedInterest + mi,
      currentBalance: l.currentPrincipal + l.accruedInterest + mi,
      monthlyAccrual: mi,
    };
  });

  const active = updated.filter(l => !l.paidOff);
  if (active.length === 0) return updated;

  const totalActiveBal = active.reduce((s, l) => s + l.currentBalance, 0);
  let remaining = Math.min(totalPayment, totalActiveBal);

  const effectiveMin = Math.min(idrMin, totalActiveBal);
  const alloc = {};
  for (const l of updated) {
    alloc[l.id] = { min: 0, extra: 0, bonus: 0, toInterest: 0, toPrincipal: 0, monthlyAccrual: l.monthlyAccrual || 0 };
  }

  // Distribute IDR minimum proportionally by balance
  for (const l of active) {
    const share = totalActiveBal > 0 ? (l.currentBalance / totalActiveBal) * effectiveMin : 0;
    alloc[l.id].min = Math.min(share, l.currentBalance);
  }
  const allocatedMin = active.reduce((s, l) => s + alloc[l.id].min, 0);
  remaining -= allocatedMin;

  // Extra payment via avalanche — highest rate first
  const byRate = [...active].sort((a, b) => b.rate - a.rate);
  for (const l of byRate) {
    if (remaining <= 0.001) break;
    const canPay = Math.max(0, l.currentBalance - alloc[l.id].min);
    const extra = Math.min(remaining, canPay);
    alloc[l.id].extra = extra;
    remaining -= extra;
  }

  // Apply payments: interest first, then principal
  const results = updated.map(l => {
    if (l.paidOff) return { ...l, alloc: alloc[l.id] };

    let pay = alloc[l.id].min + alloc[l.id].extra;
    const ip = Math.min(pay, l.accruedInterest);
    pay -= ip;
    const pp = Math.min(pay, l.currentPrincipal);

    alloc[l.id].toInterest = ip;
    alloc[l.id].toPrincipal = pp;

    const newP = l.currentPrincipal - pp;
    const newI = l.accruedInterest - ip;
    const newB = newP + newI;
    const done = newB < 0.01;

    return {
      ...l,
      currentPrincipal: done ? 0 : newP,
      accruedInterest:  done ? 0 : newI,
      currentBalance:   done ? 0 : newB,
      paidOff:          done,
      paidOffMonth:     done ? (l.paidOffMonth || "this") : l.paidOffMonth,
      alloc:            alloc[l.id],
    };
  });

  return results;
}

// Apply user-recorded actual per-loan payments for a single month.
// Mirrors simulateMonth's accrual + interest-first/principal-next math, but
// skips IDR distribution and avalanche allocation. Cap-at-balance handles
// overpayment; unpaid interest carries forward in accruedInterest with no
// monthly capitalization (matches federal Direct Loan rules, 34 CFR §685.211).
function applyRecordedPayment(loanStates, recordedMap) {
  const updated = loanStates.map(l => {
    if (l.paidOff) return { ...l, monthlyAccrual: 0 };
    const mi = l.currentPrincipal * (l.rate / 100) / 12;
    return {
      ...l,
      accruedInterest: l.accruedInterest + mi,
      currentBalance: l.currentPrincipal + l.accruedInterest + mi,
      monthlyAccrual: mi,
    };
  });

  return updated.map(l => {
    const alloc = {
      min: 0, extra: 0, bonus: 0, toInterest: 0, toPrincipal: 0,
      monthlyAccrual: l.monthlyAccrual || 0,
      recorded: true,
    };
    if (l.paidOff) return { ...l, alloc };

    const requested = Math.max(0, Number(recordedMap[l.id]) || 0);
    const pay = Math.min(requested, l.currentBalance);
    const ip = Math.min(pay, l.accruedInterest);
    const pp = pay - ip;

    alloc.min = pay;
    alloc.toInterest = ip;
    alloc.toPrincipal = pp;

    const newP = l.currentPrincipal - pp;
    const newI = l.accruedInterest - ip;
    const newB = newP + newI;
    const done = newB < 0.01;

    return {
      ...l,
      currentPrincipal: done ? 0 : newP,
      accruedInterest:  done ? 0 : newI,
      currentBalance:   done ? 0 : newB,
      paidOff:          done,
      paidOffMonth:     done ? (l.paidOffMonth || "this") : l.paidOffMonth,
      alloc,
    };
  });
}

function runSimulation(payment, idrMin, annualBonus, bonusInterval, actualPayments = {}) {
  let states = INITIAL_LOANS.map(l => ({
    ...l,
    currentBalance:  l.balance,
    accruedInterest: l.interest,
    currentPrincipal: l.principal,
    paidOff:         false,
    paidOffMonth:    null,
    monthlyAccrual:  0,
  }));

  const months = [];

  for (let m = 1; m <= 400; m++) {
    const recorded = actualPayments[m];
    const projectedIsBonus = annualBonus > 0 && ((m - 1) % bonusInterval === 0);

    if (recorded) {
      states = applyRecordedPayment(states, recorded);
    } else {
      const thisMonthTotal = payment + (projectedIsBonus ? annualBonus : 0);
      states = simulateMonth(states, thisMonthTotal, idrMin);
    }
    const activeCount = states.filter(l => !l.paidOff).length;

    // Stamp payoff month
    states = states.map(l => {
      if (l.paidOff && !l.paidOffMonth) return { ...l, paidOffMonth: m };
      if (l.paidOff && l.paidOffMonth === "this") return { ...l, paidOffMonth: m };
      return l;
    });

    // Attribute bonus portion within alloc.extra for display (skip on recorded months)
    if (!recorded && projectedIsBonus) {
      const extraTotal = states.reduce((s, l) => s + (l.alloc ? l.alloc.extra : 0), 0);
      let bonusRemaining = Math.min(annualBonus, extraTotal);
      const activeSorted = [...states]
        .filter(l => !l.paidOff || (l.alloc && l.alloc.extra > 0))
        .sort((a, b) => b.rate - a.rate);
      for (const l of activeSorted) {
        if (bonusRemaining <= 0.001) break;
        const bonusPart = Math.min(bonusRemaining, l.alloc.extra);
        l.alloc.bonus = bonusPart;
        bonusRemaining -= bonusPart;
      }
    }

    months.push({
      month: m,
      loans: states.map(l => ({ ...l, alloc: { ...l.alloc } })),
      activeCount,
      isBonus: recorded ? false : projectedIsBonus,
      recorded: !!recorded,
    });

    if (activeCount === 0) break;
  }

  return months;
}

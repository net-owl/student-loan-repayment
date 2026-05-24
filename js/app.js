// ── State ──────────────────────────────────────────────────────────────────

const state = {
  payment:        750,
  idrMin:         299.16,
  annualBonus:    5000,
  bonusInterval:  12,
  viewMonth:      1,
  fullSim:        [],
  actualPayments: {},   // { [month]: { [loanId]: amount } }
  editingMonth:   null, // month currently in edit-mode in the recorder UI
};

// ── Persistence ────────────────────────────────────────────────────────────

const LS_KEY    = "slr.actualPayments.v1";
const LS_SCHEMA = 1;

function loadActuals() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (raw && raw.schema === LS_SCHEMA && raw.payments && typeof raw.payments === "object") {
      state.actualPayments = raw.payments;
    } else if (raw) {
      console.warn("slr: stored actualPayments schema mismatch — resetting");
      state.actualPayments = {};
    }
  } catch (e) {
    console.warn("slr: failed to load actualPayments —", e);
    state.actualPayments = {};
  }
}

function persistActuals() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      schema:   LS_SCHEMA,
      payments: state.actualPayments,
    }));
    return true;
  } catch (e) {
    console.warn("slr: failed to persist actualPayments —", e);
    return false;
  }
}

// ── Calendar helpers ───────────────────────────────────────────────────────

function getCurrentCalendarMonth() {
  const now = new Date();
  const m = (now.getFullYear() - SIM_START.getFullYear()) * 12
          + (now.getMonth()    - SIM_START.getMonth()) + 1;
  return Math.max(1, m);
}

function isRecordable(month) {
  return month <= getCurrentCalendarMonth();
}

function calendarLabel(month) {
  const d = new Date(SIM_START);
  d.setMonth(d.getMonth() + (month - 1));
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// ── DOM helpers ────────────────────────────────────────────────────────────

const eid = id => document.getElementById(id);

// ── Boot ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  loadActuals();

  // Default to the most recent recorded month so the page opens from the
  // latest "paid through" perspective. Falls back to Mo 1 when nothing's
  // been recorded yet.
  const recordedMonths = Object.keys(state.actualPayments).map(Number);
  if (recordedMonths.length > 0) {
    state.viewMonth = Math.max(...recordedMonths);
  }

  eid("payment-input").value  = state.payment;
  eid("payment-range").value  = state.payment;
  eid("idr-input").value      = state.idrMin;
  eid("idr-range").value      = state.idrMin;
  eid("bonus-input").value    = state.annualBonus;
  eid("bonus-range").value    = state.annualBonus;
  eid("bonus-interval").value = state.bonusInterval;

  wireNumRange("payment-input", "payment-range", "payment",     300, runAndRender);
  wireNumRange("idr-input",     "idr-range",     "idrMin",      0,   runAndRender);
  wireNumRange("bonus-input",   "bonus-range",   "annualBonus", 0,   runAndRender);

  eid("bonus-interval").addEventListener("change", () => {
    state.bonusInterval = Number(eid("bonus-interval").value);
    runAndRender();
  });

  eid("month-range").addEventListener("input", () => {
    const newMonth = Number(eid("month-range").value);
    if (state.editingMonth !== null && state.editingMonth !== newMonth) {
      state.editingMonth = null; // close any open editor when navigating away
    }
    state.viewMonth = newMonth;
    renderMonthView();
  });

  wireDataTools();

  runAndRender();
});

// ── Wire a number input + range pair to a state key ────────────────────────

function wireNumRange(inputId, rangeId, key, minVal, callback) {
  const inp = eid(inputId);
  const rng = eid(rangeId);

  inp.addEventListener("input", () => {
    const v = Math.max(minVal, Number(inp.value));
    inp.value = v;
    rng.value = v;
    state[key] = v;
    callback();
  });

  rng.addEventListener("input", () => {
    const v = Number(rng.value);
    inp.value = v;
    state[key] = v;
    callback();
  });
}

// ── Run full simulation then refresh everything ─────────────────────────────

function runAndRender() {
  const { payment, idrMin, annualBonus, bonusInterval, actualPayments } = state;
  state.fullSim = runSimulation(payment, idrMin, annualBonus, bonusInterval, actualPayments);

  const max = state.fullSim.length;
  state.viewMonth = Math.min(state.viewMonth, max);

  const monthRng = eid("month-range");
  monthRng.max   = max;
  monthRng.value = state.viewMonth;

  eid("header-sub").textContent =
    `${fmt(payment)}/mo + ${fmt(annualBonus)} bonus every ${bonusInterval} months · ` +
    `IDR min distributed by balance · Avalanche extra + bonus targets highest rate`;

  renderMilestones();
  renderMonthView();
  renderExplainer();
}

// ── Compute derived data for the current view month ─────────────────────────

function getCurrentData() {
  const { fullSim, viewMonth, payment, annualBonus } = state;
  const max = fullSim.length;
  const safeView = Math.min(viewMonth, max);
  const mo = fullSim[safeView - 1];
  if (!mo) return null;

  const isBonus  = mo.isBonus;
  const recorded = !!mo.recorded;

  // Fixed row order across all months: rate desc, then id for a stable
  // tiebreak. Paid-off loans stay in place (not sunk) so the same loan
  // occupies the same row every month and can be compared across the timeline.
  const sorted = [...mo.loans].sort((a, b) => {
    if (b.rate !== a.rate) return b.rate - a.rate;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const active  = sorted.filter(l => !l.paidOff);
  const paidOff = sorted.filter(l => l.paidOff);

  const totals = sorted.reduce((acc, l) => {
    const a = l.alloc || {};
    return {
      min:        acc.min        + (a.min        || 0),
      extra:      acc.extra      + (a.extra      || 0),
      bonus:      acc.bonus      + (a.bonus      || 0),
      toInterest: acc.toInterest + (a.toInterest || 0),
      toPrincipal:acc.toPrincipal+ (a.toPrincipal|| 0),
      accrual:    acc.accrual    + (a.monthlyAccrual || 0),
      balance:    acc.balance    + l.currentBalance,
      total:      acc.total      + (a.min || 0) + (a.extra || 0),
    };
  }, { min:0, extra:0, bonus:0, toInterest:0, toPrincipal:0, accrual:0, balance:0, total:0 });

  // For recorded months, "this month's payment" is the actual recorded total,
  // not the projection slider. For projected months, fall back to the gross
  // payment + bonus (matches existing display behavior).
  const thisMonthPayment = recorded
    ? totals.total
    : payment + (isBonus ? annualBonus : 0);

  return { safeView, max, isBonus, recorded, thisMonthPayment, sorted, active, paidOff, totals };
}

// ── Re-render everything for the selected month ─────────────────────────────

function renderMonthView() {
  const d = getCurrentData();
  if (!d) return;
  const { safeView, max, isBonus, recorded, thisMonthPayment, sorted, active, paidOff, totals } = d;

  eid("month-display").innerHTML =
    `<span class="month-num${isBonus ? " bonus-color" : ""}${recorded ? " recorded-color" : ""}">Mo ${safeView}</span>` +
    (isBonus    ? `<span class="badge badge-bonus">BONUS</span>` : "") +
    (recorded   ? `<span class="badge badge-recorded">RECORDED</span>` : "") +
    `<span class="month-total">/ ${max}</span>`;

  eid("month-range").value = safeView;

  renderQuickJumps(safeView, max);
  renderStatusCards(active, paidOff, totals, isBonus, thisMonthPayment, recorded);
  renderBalanceWaterfall(safeView, totals);
  renderBonusBanner(isBonus, thisMonthPayment);
  renderBalanceChart(safeView);
  renderAllocationBars(sorted, thisMonthPayment, safeView, isBonus, recorded);
  renderPaymentRecorder(d);
  renderTable(sorted, totals, safeView, isBonus, thisMonthPayment, recorded);
  // Refresh milestone active state without rebuilding the whole section
  updateMilestoneActive(safeView);
}

// ── Quick-jump buttons inside the month control ─────────────────────────────

function getMilestones(fullSim) {
  return fullSim.reduce((acc, mo) => {
    const paid = mo.loans.filter(l => l.paidOffMonth === mo.month);
    if (paid.length) acc.push({ month: mo.month, loans: paid.map(l => l.id), isBonus: mo.isBonus });
    return acc;
  }, []);
}

function renderQuickJumps(safeView, max) {
  const { fullSim, actualPayments } = state;
  const milestones  = getMilestones(fullSim);
  const bonusMonths = fullSim.filter(m => m.isBonus).map(m => m.month);
  const recordedMonths = Object.keys(actualPayments).map(Number).filter(m => m <= max);

  const candidates = [
    1,
    ...milestones.map(m => m.month),
    ...bonusMonths.slice(0, 4),
    ...recordedMonths,
    max,
  ]
    .filter((v, i, a) => a.indexOf(v) === i && v <= max)
    .sort((a, b) => a - b)
    .slice(0, 12);

  eid("quick-jumps").innerHTML = candidates.map(m => {
    const ms = milestones.find(x => x.month === m);
    const bonus = bonusMonths.includes(m);
    const recorded = !!actualPayments[m];
    let cls = "jump-btn";
    if (safeView === m)       cls += " active";
    else if (recorded)        cls += " is-recorded";
    else if (bonus)           cls += " is-bonus";
    else if (ms)              cls += " is-milestone";
    const tag = `${m}${recorded ? "✓" : ""}${ms ? "★" : ""}${bonus && !recorded ? "$" : ""}`;
    return `<button class="${cls}" data-month="${m}">${tag}</button>`;
  }).join("");

  eid("quick-jumps").querySelectorAll(".jump-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const newMonth = Number(btn.dataset.month);
      if (state.editingMonth !== null && state.editingMonth !== newMonth) {
        state.editingMonth = null;
      }
      state.viewMonth = newMonth;
      eid("month-range").value = state.viewMonth;
      renderMonthView();
    });
  });
}

// ── Status cards row ────────────────────────────────────────────────────────

function renderStatusCards(active, paidOff, totals, isBonus, thisMonthPayment, recorded) {
  const { payment, idrMin, annualBonus, actualPayments } = state;

  const recordedKeys = Object.keys(actualPayments).map(Number);
  const recordedCount = recordedKeys.length;
  const recordedThrough = recordedCount > 0 ? Math.max(...recordedKeys) : null;

  const cards = [
    {
      label: recorded ? "Recorded Payment" : "This Month's Payment",
      value: fmt(thisMonthPayment),
      color: recorded ? "green" : (isBonus ? "amber" : "teal"),
      sub: recorded
        ? "actual amount paid"
        : (isBonus ? `${fmt(payment)} + ${fmt(annualBonus)} bonus` : `${fmt(payment)} monthly`),
    },
    {
      label: "Active / Paid Off",
      value: `${active.length} / ${paidOff.length}`,
      color: "teal",
      sub: "of 11 loans",
    },
    {
      label: "IDR Spread",
      value: `${fmt(idrMin)} ÷ ${active.length}`,
      color: "amber",
      sub: `~${fmt(active.length > 0 ? idrMin / active.length : 0)} each`,
    },
    {
      label: "Extra → Target",
      value: fmt(totals.extra),
      color: "teal",
      sub: isBonus ? `includes ${fmt(totals.bonus)} bonus` : "monthly extra only",
    },
    {
      label: "Monthly Interest",
      value: fmt(totals.accrual),
      color: "red",
      sub: `across ${active.length} loans`,
    },
    {
      label: "Remaining Balance",
      value: fmt(totals.balance),
      color: "dim",
      sub: `${((1 - totals.balance / TOTAL_BALANCE) * 100).toFixed(1)}% paid down`,
    },
    {
      label: "Recorded Months",
      value: recordedCount > 0 ? `${recordedCount}` : "—",
      color: recordedCount > 0 ? "green" : "dim",
      sub: recordedThrough
        ? `through Mo ${recordedThrough} · ${calendarLabel(recordedThrough)}`
        : "no actuals recorded yet",
    },
  ];

  eid("status-cards").innerHTML = cards.map(c => `
    <div class="stat-card">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value color-${c.color}">${c.value}</div>
      <div class="stat-sub">${c.sub}</div>
    </div>
  `).join("");
}

// ── Bonus banner ────────────────────────────────────────────────────────────

function renderBonusBanner(isBonus, thisMonthPayment) {
  const el = eid("bonus-banner");
  if (!isBonus) {
    el.innerHTML = "";
    el.className = "";
    return;
  }
  const { payment, annualBonus } = state;
  el.className = "bonus-banner";
  el.innerHTML = `
    <div class="bonus-banner-icon">💰</div>
    <div>
      <div class="bonus-banner-title">Bonus Month — ${fmt(annualBonus)} extra applied</div>
      <div class="bonus-banner-sub">
        Total payment this month: ${fmt(thisMonthPayment)} · Bonus targets highest-rate active loan via avalanche
      </div>
    </div>
  `;
}

// ── Per-month balance waterfall ─────────────────────────────────────────────
// Makes the carry-forward explicit: Beginning (= prior month's ending) plus the
// interest that accrued, minus what was paid, equals this month's Ending. The
// balance can only rise by accrued interest, never spontaneously — this is what
// dispels the "ending higher than next beginning" misread.

function renderBalanceWaterfall(safeView, totals) {
  const el = eid("balance-waterfall");
  if (!el) return;

  const paid      = totals.toInterest + totals.toPrincipal;
  const ending    = totals.balance;
  const beginning = ending + paid - totals.accrual; // == prior month's ending

  el.className = "panel waterfall-panel";
  el.innerHTML = `
    <div class="panel-header">
      <span class="panel-title">Portfolio Balance · Month ${safeView}</span>
      <span class="panel-sub">Beginning = prior month's ending</span>
    </div>
    <div class="waterfall">
      <div class="wf-step">
        <div class="wf-label">Beginning</div>
        <div class="wf-value">${fmt(beginning)}</div>
      </div>
      <div class="wf-op color-red">+</div>
      <div class="wf-step">
        <div class="wf-label">Interest accrued</div>
        <div class="wf-value color-red">${fmt(totals.accrual)}</div>
      </div>
      <div class="wf-op color-green">−</div>
      <div class="wf-step">
        <div class="wf-label">Paid this month</div>
        <div class="wf-value color-green">${fmt(paid)}</div>
      </div>
      <div class="wf-op">=</div>
      <div class="wf-step wf-step--end">
        <div class="wf-label">Ending</div>
        <div class="wf-value">${fmt(ending)}</div>
      </div>
    </div>
  `;
}

// ── Balance trajectory chart ────────────────────────────────────────────────
// Inline SVG (no dependency) plotting total balance across the whole schedule,
// so the monotonic decline is visible at a glance. Click to jump to a month.

function renderBalanceChart(safeView) {
  const el = eid("balance-chart");
  if (!el) return;

  const sim = state.fullSim || [];
  const n = sim.length;
  if (n < 2) { el.innerHTML = ""; el.className = ""; return; }

  const series = sim.map(mo =>
    mo.loans.reduce((s, l) => s + (l.paidOff ? 0 : l.currentBalance), 0)
  );

  const W = 1000, H = 150, padX = 28, padT = 14, padB = 22;
  const plotW = W - padX * 2;
  const plotH = H - padT - padB;
  const maxBal = TOTAL_BALANCE || Math.max(...series, 1);

  const xAt = i => padX + (n === 1 ? 0 : (i / (n - 1)) * plotW);
  const yAt = v => padT + (1 - v / maxBal) * plotH;

  const pts = series.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  const areaPts = `${padX},${(padT + plotH).toFixed(1)} ${pts} ${(padX + plotW).toFixed(1)},${(padT + plotH).toFixed(1)}`;

  const milestones = getMilestones(sim);
  const milestoneDots = milestones.map(m => {
    const i = m.month - 1;
    if (i < 0 || i >= n) return "";
    return `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(series[i]).toFixed(1)}" r="2.5" fill="var(--amber)" />`;
  }).join("");

  const curIdx = Math.min(Math.max(safeView - 1, 0), n - 1);
  const cx = xAt(curIdx), cy = yAt(series[curIdx]);

  el.className = "panel balance-chart";
  el.innerHTML = `
    <div class="panel-header">
      <span class="panel-title">Balance Trajectory</span>
      <span class="panel-sub">${n} months · ${fmt(series[0])} → ${fmt(series[n - 1])}</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Total balance over time">
      <line class="chart-baseline" x1="${padX}" y1="${padT + plotH}" x2="${padX + plotW}" y2="${padT + plotH}" />
      <polygon class="chart-area" points="${areaPts}" />
      <polyline class="chart-line" points="${pts}" />
      <line class="chart-cursor" x1="${cx.toFixed(1)}" y1="${padT}" x2="${cx.toFixed(1)}" y2="${(padT + plotH).toFixed(1)}" />
      ${milestoneDots}
      <circle class="chart-cursor-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" />
    </svg>
  `;

  const svg = el.querySelector("svg");
  svg.addEventListener("click", (e) => {
    const rect = svg.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const inner = (frac * W - padX) / plotW;
    const month = Math.min(Math.max(Math.round(inner * (n - 1)) + 1, 1), n);
    state.viewMonth = month;
    eid("month-range").value = month;
    renderMonthView();
  });
}

// ── Allocation bar chart ─────────────────────────────────────────────────────

function renderAllocationBars(sorted, thisMonthPayment, safeView, isBonus, recorded) {
  const rows = sorted.map(loan => {
    const a = loan.alloc || {};
    const total    = (a.min || 0) + (a.extra || 0);
    const faded    = loan.paidOff && total < 0.005;
    if (faded && total < 0.005) {
      // Show a greyed-out placeholder for fully-done loans
    }

    const intPct  = total > 0 ? ((a.toInterest  || 0) / total) * 100 : 0;
    const prinPct = total > 0 ? ((a.toPrincipal || 0) / total) * 100 : 0;
    const barW    = Math.max(0, (total / thisMonthPayment) * 100);
    const hasExtra = (a.extra || 0) > 0.01;
    const hasBonus = (a.bonus || 0) > 0.01;

    const rateClass = loan.rate >= 6.5 ? "bar-rate--high" : loan.rate >= 5.5 ? "bar-rate--mid" : "bar-rate--low";
    const idClass   = loan.paidOff ? "bar-id--done" : "";
    const idLabel   = loan.paidOff && total < 0.01 ? "✓" : loan.id;

    const prinSeg = hasBonus ? "bar-seg-principal-bonus"
                  : hasExtra ? "bar-seg-principal-extra"
                  : "bar-seg-principal";

    const totalClass = total < 0.01  ? "bar-total--none"
                     : hasBonus       ? "bar-total--bonus"
                     : hasExtra       ? "bar-total--extra"
                     : "bar-total--normal";

    return `
      <div class="bar-row${faded ? " bar-row--faded" : ""}">
        <div class="bar-id ${idClass}">${idLabel}</div>
        <div class="bar-rate ${rateClass}">${loan.rate}%</div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${barW}%">
            <div class="bar-segment ${prinSeg}" style="width:${prinPct}%">
              ${prinPct > 15 && (a.toPrincipal || 0) > 1 ? fmt(a.toPrincipal) : ""}
            </div>
            <div class="bar-segment bar-seg-interest" style="width:${intPct}%">
              ${intPct > 15 && (a.toInterest || 0) > 1 ? fmt(a.toInterest) : ""}
            </div>
          </div>
        </div>
        <div class="bar-total ${totalClass}">${total > 0.01 ? fmt(total) : "—"}</div>
      </div>
    `;
  }).join("");

  eid("allocation-bars").innerHTML = `
    <div class="panel-header">
      <span class="panel-title">
        Payment Flow · Month ${safeView}${isBonus ? " (Bonus)" : ""}${recorded ? " (Recorded ✓)" : ""}
      </span>
      <div class="bars-legend">
        <span class="color-green">■ Principal</span>
        <span class="color-red">■ Interest</span>
        ${isBonus ? '<span class="color-amber">$ Bonus</span>' : ""}
        ${recorded ? '<span class="color-green">✓ Recorded actuals</span>' : ""}
      </div>
    </div>
    <div class="bars-content">${rows}</div>
  `;
}

// ── Payment recorder (actuals) ─────────────────────────────────────────────

function renderPaymentRecorder(d) {
  const el = eid("payment-recorder");
  if (!el) return;

  const { safeView, sorted } = d;
  const { actualPayments, fullSim, editingMonth } = state;
  const recordable = isRecordable(safeView);
  const recorded   = actualPayments[safeView];
  const dateLabel  = calendarLabel(safeView);

  // Loan status entering this month — read from the prior month's end-state.
  // For Mo 1, fall back to INITIAL_LOANS (none paid off).
  const priorLoans = safeView > 1 && fullSim[safeView - 2]
    ? fullSim[safeView - 2].loans
    : INITIAL_LOANS.map(l => ({ id: l.id, paidOff: false, paidOffMonth: null }));
  const priorById = Object.fromEntries(priorLoans.map(l => [l.id, l]));

  // Future months: show a faint message, no controls
  if (!recordable) {
    el.className = "panel recorder-panel recorder-future-panel";
    el.innerHTML = `
      <div class="panel-header">
        <span class="panel-title">Recorded Payment · Mo ${safeView} · ${dateLabel}</span>
      </div>
      <div class="recorder-future">
        Future projection — not yet recordable.
        Recording opens once the calendar reaches ${dateLabel}.
      </div>
    `;
    return;
  }

  const isEditing = editingMonth === safeView;

  // View mode
  if (!isEditing) {
    const recordedTotal = recorded
      ? Object.values(recorded).reduce((s, v) => s + (Number(v) || 0), 0)
      : 0;

    el.className = "panel recorder-panel";
    el.innerHTML = `
      <div class="panel-header">
        <span class="panel-title">
          Recorded Payment · Mo ${safeView} · ${dateLabel}
          ${recorded ? '<span class="recorded-badge">Recorded ✓</span>' : ""}
        </span>
        <span class="panel-sub">
          ${recorded
            ? `Total recorded: ${fmt(recordedTotal)}`
            : "Replace this month's projection with the amounts you actually paid."}
        </span>
      </div>
      <div class="recorder-actions">
        ${recorded
          ? `<button class="btn-secondary" id="recorder-edit">Edit</button>
             <button class="btn-danger"    id="recorder-clear">Clear</button>`
          : `<button class="btn-primary"   id="recorder-record">Record Actual Payment for Mo ${safeView}</button>`}
      </div>
    `;
    if (recorded) {
      eid("recorder-edit").addEventListener("click", () => {
        state.editingMonth = safeView;
        renderMonthView();
      });
      eid("recorder-clear").addEventListener("click", () => {
        if (confirm(`Clear recorded payment for Mo ${safeView} (${dateLabel})? Future projections will recompute from the original projection.`)) {
          clearRecording(safeView);
        }
      });
    } else {
      eid("recorder-record").addEventListener("click", () => {
        state.editingMonth = safeView;
        renderMonthView();
      });
    }
    return;
  }

  // Edit mode — render a per-loan input form.
  // Pre-fill from existing recorded values if present, else from projected
  // toInterest+toPrincipal per loan in `sorted`.
  const sortedById = Object.fromEntries(sorted.map(l => [l.id, l]));

  const rowsHtml = INITIAL_LOANS.map(base => {
    const projected   = sortedById[base.id];
    const enteredPaid = priorById[base.id]?.paidOff;
    const projTotal   = projected
      ? ((projected.alloc?.toInterest || 0) + (projected.alloc?.toPrincipal || 0))
      : 0;
    const prefill = recorded && recorded[base.id] !== undefined
      ? Number(recorded[base.id])
      : (enteredPaid ? 0 : projTotal);
    const priorBal = projected ? (projected.currentBalance + (projected.alloc?.toInterest || 0) + (projected.alloc?.toPrincipal || 0)) : 0;
    const rateColor = base.rate >= 6.5 ? "var(--red)" : base.rate >= 5.5 ? "var(--amber)" : "var(--green)";

    if (enteredPaid) {
      const paidOffMonth = priorById[base.id]?.paidOffMonth;
      return `
        <div class="recorder-row recorder-row--paidoff">
          <div class="recorder-loan">
            <span class="recorder-loan-id">${base.id}</span>
            <span class="recorder-loan-meta">${base.program} · <span style="color:${rateColor}">${base.rate.toFixed(3)}%</span></span>
          </div>
          <input type="number" class="recorder-input" data-loan-id="${base.id}" value="0" min="0" step="0.01" disabled>
          <span class="recorder-sub">Paid off Mo ${paidOffMonth || "—"}</span>
        </div>
      `;
    }

    return `
      <div class="recorder-row">
        <div class="recorder-loan">
          <span class="recorder-loan-id">${base.id}</span>
          <span class="recorder-loan-meta">${base.program} · <span style="color:${rateColor}">${base.rate.toFixed(3)}%</span></span>
        </div>
        <input type="number" class="recorder-input" data-loan-id="${base.id}"
               value="${prefill.toFixed(2)}" min="0" step="0.01">
        <span class="recorder-sub">
          Pre-pay bal ${fmt(priorBal)} · Projected ${fmt(projTotal)}
        </span>
      </div>
    `;
  }).join("");

  el.className = "panel recorder-panel recorder-expanded";
  el.innerHTML = `
    <div class="panel-header">
      <span class="panel-title">
        Recording Payment · Mo ${safeView} · ${dateLabel}
      </span>
      <span class="panel-sub" id="recorder-running-total">Total: —</span>
    </div>
    <div class="recorder-help">
      Enter what you actually paid to each loan this month. Pre-filled with the
      projected allocation. Payments apply interest-first, then principal.
      Overpayments are capped at the loan's balance. Unpaid interest carries
      forward (no monthly capitalization).
    </div>
    <div class="recorder-rows">${rowsHtml}</div>
    <div class="recorder-actions">
      <button class="btn-primary"   id="recorder-save">Save</button>
      <button class="btn-secondary" id="recorder-cancel">Cancel</button>
    </div>
    <div class="recorder-status" id="recorder-status"></div>
  `;

  const updateRunningTotal = () => {
    const total = Array.from(el.querySelectorAll(".recorder-input"))
      .reduce((s, inp) => s + (Number(inp.value) || 0), 0);
    eid("recorder-running-total").textContent = `Total: ${fmt(total)}`;
  };
  el.querySelectorAll(".recorder-input").forEach(inp => {
    inp.addEventListener("input", updateRunningTotal);
  });
  updateRunningTotal();

  eid("recorder-cancel").addEventListener("click", () => {
    state.editingMonth = null;
    renderMonthView();
  });

  eid("recorder-save").addEventListener("click", () => {
    const loanMap = {};
    const warnings = [];
    el.querySelectorAll(".recorder-input").forEach(inp => {
      if (inp.disabled) return;
      const id = inp.dataset.loanId;
      const v = Math.max(0, Number(inp.value) || 0);
      loanMap[id] = v;

      // Warn if user is overpaying — non-blocking
      const projected = sortedById[id];
      const priorBal = projected
        ? (projected.currentBalance + (projected.alloc?.toInterest || 0) + (projected.alloc?.toPrincipal || 0))
        : 0;
      if (v > priorBal + 0.01) {
        warnings.push(`${id}: $${v.toFixed(2)} exceeds balance $${priorBal.toFixed(2)} — capped on save.`);
      }
    });
    saveRecording(safeView, loanMap);
    if (warnings.length) {
      // Briefly surface clip warnings — runAndRender just rebuilt the panel,
      // so attach to the now-current view-mode panel.
      const status = document.createElement("div");
      status.className = "recorder-status recorder-status--warn";
      status.textContent = "Capped overpayments: " + warnings.join(" ");
      eid("payment-recorder").appendChild(status);
    }
  });
}

function saveRecording(month, loanMap) {
  state.actualPayments[month] = loanMap;
  persistActuals();
  state.editingMonth = null;
  runAndRender();
}

function clearRecording(month) {
  delete state.actualPayments[month];
  persistActuals();
  state.editingMonth = null;
  runAndRender();
}

// ── Data tools (export / import) ───────────────────────────────────────────

function wireDataTools() {
  const exportBtn = eid("export-actuals");
  const importBtn = eid("import-actuals");
  const fileInp   = eid("import-file");
  const status    = eid("data-tools-status");
  if (!exportBtn || !importBtn || !fileInp) return;

  const setStatus = (msg, kind = "info") => {
    if (!status) return;
    status.className = "data-tools-status data-tools-status--" + kind;
    status.textContent = msg || "";
  };

  exportBtn.addEventListener("click", () => {
    const payload = {
      schema:     LS_SCHEMA,
      exportedAt: new Date().toISOString(),
      payments:   state.actualPayments,
    };
    const months = Object.keys(state.actualPayments).length;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `student-loan-actuals-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus(months > 0
      ? `Exported ${months} month${months === 1 ? "" : "s"} of recorded payments.`
      : "Exported (no recorded payments yet).", "ok");
  });

  importBtn.addEventListener("click", () => {
    fileInp.click();
  });

  fileInp.addEventListener("change", () => {
    const file = fileInp.files && fileInp.files[0];
    fileInp.value = ""; // allow re-selecting the same file
    if (!file) return;

    const reader = new FileReader();
    reader.onerror = () => setStatus("Could not read file.", "err");
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        setStatus("Import failed: file is not valid JSON.", "err");
        return;
      }
      const validation = validateImportPayload(parsed);
      if (!validation.ok) {
        setStatus("Import failed: " + validation.error, "err");
        return;
      }
      const incoming = validation.payments;
      const incomingCount = Object.keys(incoming).length;
      const haveExisting = Object.keys(state.actualPayments).length > 0;
      if (haveExisting) {
        const proceed = confirm(
          "Importing will replace your currently recorded payments. Continue?"
        );
        if (!proceed) {
          setStatus("Import cancelled — current data unchanged.", "info");
          return;
        }
      }
      state.actualPayments = incoming;
      persistActuals();
      state.editingMonth = null;
      runAndRender();
      setStatus(`Imported ${incomingCount} month${incomingCount === 1 ? "" : "s"} of recorded payments.`, "ok");
    };
    reader.readAsText(file);
  });
}

function validateImportPayload(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "expected an object." };
  }
  if (parsed.schema !== LS_SCHEMA) {
    return { ok: false, error: `schema ${parsed.schema} does not match expected ${LS_SCHEMA}.` };
  }
  const payments = parsed.payments;
  if (!payments || typeof payments !== "object" || Array.isArray(payments)) {
    return { ok: false, error: "missing or malformed 'payments' object." };
  }
  const knownIds = new Set(INITIAL_LOANS.map(l => l.id));
  const cleaned = {};
  for (const [k, v] of Object.entries(payments)) {
    const monthNum = Number(k);
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 400) {
      return { ok: false, error: `invalid month key '${k}'.` };
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return { ok: false, error: `month ${k}: payment map must be an object.` };
    }
    const inner = {};
    for (const [loanId, amt] of Object.entries(v)) {
      if (!knownIds.has(loanId)) {
        return { ok: false, error: `month ${k}: unknown loan id '${loanId}'.` };
      }
      const num = Number(amt);
      if (!Number.isFinite(num) || num < 0) {
        return { ok: false, error: `month ${k}, loan ${loanId}: amount must be a non-negative number.` };
      }
      inner[loanId] = num;
    }
    cleaned[monthNum] = inner;
  }
  return { ok: true, payments: cleaned };
}

// ── Detailed allocation table ───────────────────────────────────────────────

function renderTable(sorted, totals, safeView, isBonus, thisMonthPayment, recorded) {
  const { payment, annualBonus } = state;

  const isRecordedMonth = !!recorded;

  const rows = sorted.map((loan, idx) => {
    const a = loan.alloc || {};
    const totalPay   = (a.min || 0) + (a.extra || 0);
    const monthlyExtra = (a.extra || 0) - (a.bonus || 0);
    const hasExtra   = monthlyExtra > 0.01;
    const hasBonus   = (a.bonus || 0) > 0.01;
    const isPaidOff  = loan.paidOff && totalPay < 0.01;
    const justPaid   = loan.paidOff && totalPay > 0.01;
    const isRecorded = !!a.recorded;
    const preBal     = loan.currentBalance + (a.toInterest || 0) + (a.toPrincipal || 0);

    let rowClass = "";
    if (isPaidOff)        rowClass = "row-paidoff";
    else if (justPaid)    rowClass = "row-justpaidoff";
    else if (isRecorded)  rowClass = "row-recorded";
    else if (hasBonus)    rowClass = "row-bonus";
    else if (hasExtra)    rowClass = "row-extra";

    const rateColor = loan.rate >= 6.5 ? "var(--red)" : loan.rate >= 5.5 ? "var(--amber)" : "var(--green)";
    const idxColor  = hasBonus ? "var(--amber)" : hasExtra ? "var(--teal)" : "var(--text-faint)";
    const idColor   = justPaid ? "var(--green)"  : isPaidOff ? "var(--text-faint)" : "var(--text)";

    return `
      <tr class="${rowClass}">
        <td class="left" style="text-align:center;font-size:9px;color:${idxColor};font-weight:700">
          ${isPaidOff ? "✓" : idx + 1}
        </td>
        <td class="left">
          <span style="font-weight:600;color:${idColor};font-size:11px">${loan.id}${loan.paidOff ? " ✓" : ""}</span>
          <span style="font-size:7px;color:var(--text-dimmer);margin-left:3px">${loan.program}</span>
          ${justPaid ? '<span class="badge badge-paid">PAID OFF</span>' : ""}
        </td>
        <td style="font-weight:600;color:${rateColor}">${loan.rate.toFixed(3)}%</td>
        <td style="color:var(--text-dim)">${isPaidOff ? "—" : fmt(preBal)}</td>
        <td style="color:var(--red)">${isPaidOff ? "—" : fmt(a.monthlyAccrual || 0)}</td>
        <td style="color:var(--text-dim)">${(a.min || 0) > 0.01 ? fmt(a.min) : "—"}</td>
        <td style="font-weight:${hasExtra ? 600 : 400};color:${hasExtra ? "var(--teal)" : "var(--text-dimmer)"}">
          ${monthlyExtra > 0.01 ? "+" + fmt(monthlyExtra) : "—"}
        </td>
        <td style="font-weight:${hasBonus ? 700 : 400};color:${hasBonus ? "var(--amber)" : "var(--text-dimmer)"}">
          ${hasBonus ? "+" + fmt(a.bonus) : "—"}
        </td>
        <td style="font-weight:700;color:${totalPay > 0.01 ? "var(--text-bright)" : "var(--text-dimmer)"}">
          ${totalPay > 0.01 ? fmt(totalPay) : "—"}
        </td>
        <td style="color:var(--red)">${(a.toInterest || 0) > 0.01 ? fmt(a.toInterest) : "—"}</td>
        <td style="color:var(--green);font-weight:600">${(a.toPrincipal || 0) > 0.01 ? fmt(a.toPrincipal) : "—"}</td>
        <td style="color:${loan.paidOff ? "var(--green)" : "var(--text-dim)"};font-weight:${loan.paidOff ? 700 : 400}">
          ${loan.paidOff ? "$0.00" : fmt(loan.currentBalance)}
        </td>
      </tr>
    `;
  }).join("");

  eid("allocation-table").innerHTML = `
    <div class="panel-header">
      <span class="panel-title">
        Detailed Allocation · Month ${safeView}${isBonus ? " 💰" : ""}${isRecordedMonth ? " ✓" : ""}
      </span>
      <span class="panel-sub">
        ${isRecordedMonth ? "Recorded actuals · " : ""}Total: ${fmt(thisMonthPayment)}
        ${isBonus ? `(${fmt(payment)} + ${fmt(annualBonus)} bonus)` : ""}
      </span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="left" style="text-align:center">#</th>
            <th class="left">Loan</th>
            <th>Rate</th>
            <th>Pre-Pay Bal</th>
            <th style="color:var(--red)">Mo Interest</th>
            <th>${isRecordedMonth ? '<span class="color-green">Actual Paid</span>' : "IDR Share"}</th>
            <th style="color:var(--teal)">Monthly Extra</th>
            <th style="color:var(--amber)">Bonus</th>
            <th style="color:var(--text-bright)">Total Pay</th>
            <th style="color:var(--red)">→ Interest</th>
            <th style="color:var(--green)">→ Principal</th>
            <th>Post-Pay Bal</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="text-align:right;font-weight:700;color:var(--text-dim);font-size:8px;letter-spacing:1px">TOTALS</td>
            <td style="font-weight:700;color:var(--text-bright)">${fmt(totals.balance + totals.toInterest + totals.toPrincipal)}</td>
            <td style="color:var(--red);font-weight:600">${fmt(totals.accrual)}</td>
            <td style="color:var(--text-dim);font-weight:600">${fmt(totals.min)}</td>
            <td style="color:var(--teal);font-weight:700">+${fmt(Math.max(0, totals.extra - totals.bonus))}</td>
            <td style="color:var(--amber);font-weight:700">${totals.bonus > 0.01 ? "+" + fmt(totals.bonus) : "—"}</td>
            <td style="font-weight:700;color:var(--text-bright)">${fmt(totals.total)}</td>
            <td style="color:var(--red);font-weight:600">${fmt(totals.toInterest)}</td>
            <td style="color:var(--green);font-weight:700">${fmt(totals.toPrincipal)}</td>
            <td style="font-weight:700;color:var(--text-bright)">${fmt(totals.balance)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

// ── Payoff milestones ───────────────────────────────────────────────────────

function renderMilestones() {
  const { fullSim, actualPayments } = state;
  const milestones = getMilestones(fullSim);
  const el = eid("milestones");

  if (!milestones.length) { el.innerHTML = ""; return; }

  const safeView = Math.min(state.viewMonth, fullSim.length);

  el.innerHTML = `
    <div class="milestones-panel">
      <div class="milestones-title">Payoff Milestones — Click to Jump</div>
      <div class="milestones-grid">
        ${milestones.map(m => {
          const d = new Date(SIM_START);
          d.setMonth(d.getMonth() + m.month);
          const dateStr  = d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
          const isActive = safeView === m.month;
          const isRecorded = !!actualPayments[m.month];
          return `
            <button
              class="milestone-btn${isActive ? " active" : ""}${m.isBonus ? " is-bonus" : ""}${isRecorded ? " is-recorded" : ""}"
              data-month="${m.month}">
              <div class="milestone-month">Mo ${m.month} · ${dateStr}${m.isBonus ? " 💰" : ""}${isRecorded ? " ✓" : ""}</div>
              <div class="milestone-loans">${m.loans.join(", ")} paid off${isRecorded ? " (recorded)" : ""}</div>
            </button>
          `;
        }).join("")}
      </div>
    </div>
  `;

  el.querySelectorAll(".milestone-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const newMonth = Number(btn.dataset.month);
      if (state.editingMonth !== null && state.editingMonth !== newMonth) {
        state.editingMonth = null;
      }
      state.viewMonth = newMonth;
      eid("month-range").value = state.viewMonth;
      renderMonthView();
    });
  });
}

// Cheap update: just toggle active class on existing buttons
function updateMilestoneActive(safeView) {
  eid("milestones").querySelectorAll(".milestone-btn").forEach(btn => {
    btn.classList.toggle("active", Number(btn.dataset.month) === safeView);
  });
}

// ── Explainer block ─────────────────────────────────────────────────────────

function renderExplainer() {
  const { payment, idrMin, annualBonus, bonusInterval, fullSim } = state;
  const max         = fullSim.length;
  const bonusPaid   = fullSim.filter(m => m.isBonus && m.month <= max).length;

  eid("explainer").innerHTML = `
    <div class="explainer-icon">📐</div>
    <div class="explainer-body">
      <div class="explainer-title">How This Model Works</div>
      <strong style="color:var(--text-dim)">IDR Share:</strong>
      ${fmt(idrMin)} distributed proportionally by balance across all active loans.
      <strong style="color:var(--teal)">Monthly Extra:</strong>
      ${fmt(payment)} − ${fmt(idrMin)} = ${fmt(payment - idrMin)} to highest-rate loan.
      <strong style="color:var(--amber)">Bonus:</strong>
      ${fmt(annualBonus)} applied on months 1, ${1 + bonusInterval}, ${1 + bonusInterval * 2}, …
      also targeting highest rate. The table separates the monthly extra from the bonus
      so you can see exactly what each contributes.
      Over ${max} months, ${bonusPaid} bonus payments totaling ${fmt(bonusPaid * annualBonus)} are applied.
    </div>
  `;
}

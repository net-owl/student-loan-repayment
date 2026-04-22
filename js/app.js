// ── State ──────────────────────────────────────────────────────────────────

const state = {
  payment:       750,
  idrMin:        299.16,
  annualBonus:   5000,
  bonusInterval: 12,
  viewMonth:     1,
  fullSim:       [],
};

// ── DOM helpers ────────────────────────────────────────────────────────────

const eid = id => document.getElementById(id);

// ── Boot ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
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
    state.viewMonth = Number(eid("month-range").value);
    renderMonthView();
  });

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
  const { payment, idrMin, annualBonus, bonusInterval } = state;
  state.fullSim = runSimulation(payment, idrMin, annualBonus, bonusInterval);

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

  const isBonus = mo.isBonus;
  const thisMonthPayment = payment + (isBonus ? annualBonus : 0);

  const sorted = [...mo.loans].sort((a, b) => {
    if (a.paidOff && !b.paidOff) return 1;
    if (!a.paidOff && b.paidOff) return -1;
    return b.rate - a.rate;
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

  return { safeView, max, isBonus, thisMonthPayment, sorted, active, paidOff, totals };
}

// ── Re-render everything for the selected month ─────────────────────────────

function renderMonthView() {
  const d = getCurrentData();
  if (!d) return;
  const { safeView, max, isBonus, thisMonthPayment, sorted, active, paidOff, totals } = d;

  eid("month-display").innerHTML =
    `<span class="month-num${isBonus ? " bonus-color" : ""}">Mo ${safeView}</span>` +
    (isBonus ? `<span class="badge badge-bonus">BONUS</span>` : "") +
    `<span class="month-total">/ ${max}</span>`;

  eid("month-range").value = safeView;

  renderQuickJumps(safeView, max);
  renderStatusCards(active, paidOff, totals, isBonus, thisMonthPayment);
  renderBonusBanner(isBonus, thisMonthPayment);
  renderAllocationBars(sorted, thisMonthPayment, safeView, isBonus);
  renderTable(sorted, totals, safeView, isBonus, thisMonthPayment);
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
  const { fullSim } = state;
  const milestones  = getMilestones(fullSim);
  const bonusMonths = fullSim.filter(m => m.isBonus).map(m => m.month);

  const candidates = [1, ...milestones.map(m => m.month), ...bonusMonths.slice(0, 4), max]
    .filter((v, i, a) => a.indexOf(v) === i && v <= max)
    .sort((a, b) => a - b)
    .slice(0, 10);

  eid("quick-jumps").innerHTML = candidates.map(m => {
    const ms = milestones.find(x => x.month === m);
    const bonus = bonusMonths.includes(m);
    let cls = "jump-btn";
    if (safeView === m) cls += " active";
    else if (bonus)     cls += " is-bonus";
    else if (ms)        cls += " is-milestone";
    return `<button class="${cls}" data-month="${m}">${m}${ms ? "★" : ""}${bonus ? "$" : ""}</button>`;
  }).join("");

  eid("quick-jumps").querySelectorAll(".jump-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.viewMonth = Number(btn.dataset.month);
      eid("month-range").value = state.viewMonth;
      renderMonthView();
    });
  });
}

// ── Status cards row ────────────────────────────────────────────────────────

function renderStatusCards(active, paidOff, totals, isBonus, thisMonthPayment) {
  const { payment, idrMin, annualBonus } = state;

  const cards = [
    {
      label: "This Month's Payment",
      value: fmt(thisMonthPayment),
      color: isBonus ? "amber" : "teal",
      sub: isBonus ? `${fmt(payment)} + ${fmt(annualBonus)} bonus` : `${fmt(payment)} monthly`,
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

// ── Allocation bar chart ─────────────────────────────────────────────────────

function renderAllocationBars(sorted, thisMonthPayment, safeView, isBonus) {
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
      <span class="panel-title">Payment Flow · Month ${safeView}${isBonus ? " (Bonus)" : ""}</span>
      <div class="bars-legend">
        <span class="color-green">■ Principal</span>
        <span class="color-red">■ Interest</span>
        ${isBonus ? '<span class="color-amber">$ Bonus</span>' : ""}
      </div>
    </div>
    <div class="bars-content">${rows}</div>
  `;
}

// ── Detailed allocation table ───────────────────────────────────────────────

function renderTable(sorted, totals, safeView, isBonus, thisMonthPayment) {
  const { payment, annualBonus } = state;

  const rows = sorted.map((loan, idx) => {
    const a = loan.alloc || {};
    const totalPay   = (a.min || 0) + (a.extra || 0);
    const monthlyExtra = (a.extra || 0) - (a.bonus || 0);
    const hasExtra   = monthlyExtra > 0.01;
    const hasBonus   = (a.bonus || 0) > 0.01;
    const isPaidOff  = loan.paidOff && totalPay < 0.01;
    const justPaid   = loan.paidOff && totalPay > 0.01;
    const preBal     = loan.currentBalance + (a.toInterest || 0) + (a.toPrincipal || 0);

    let rowClass = "";
    if (isPaidOff) rowClass = "row-paidoff";
    else if (justPaid) rowClass = "row-justpaidoff";
    else if (hasBonus) rowClass = "row-bonus";
    else if (hasExtra) rowClass = "row-extra";

    const rateColor = loan.rate >= 6.5 ? "var(--red)" : loan.rate >= 5.5 ? "var(--amber)" : "var(--green)";
    const idxColor  = hasBonus ? "var(--amber)" : hasExtra ? "var(--teal)" : "var(--text-faint)";
    const idColor   = justPaid ? "var(--green)"  : isPaidOff ? "var(--text-faint)" : "var(--text)";

    return `
      <tr class="${rowClass}">
        <td class="left" style="text-align:center;font-size:9px;color:${idxColor};font-weight:700">
          ${isPaidOff ? "✓" : idx + 1}
        </td>
        <td class="left">
          <span style="font-weight:600;color:${idColor};font-size:11px">${loan.id}${justPaid ? " ★" : ""}</span>
          <span style="font-size:7px;color:var(--text-dimmer);margin-left:3px">${loan.program}</span>
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
      <span class="panel-title">Detailed Allocation · Month ${safeView}${isBonus ? " 💰" : ""}</span>
      <span class="panel-sub">
        Total: ${fmt(thisMonthPayment)}
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
            <th>IDR Share</th>
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
  const { fullSim } = state;
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
          return `
            <button
              class="milestone-btn${isActive ? " active" : ""}${m.isBonus ? " is-bonus" : ""}"
              data-month="${m.month}">
              <div class="milestone-month">Mo ${m.month} · ${dateStr}${m.isBonus ? " 💰" : ""}</div>
              <div class="milestone-loans">${m.loans.join(", ")} paid off</div>
            </button>
          `;
        }).join("")}
      </div>
    </div>
  `;

  el.querySelectorAll(".milestone-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.viewMonth = Number(btn.dataset.month);
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

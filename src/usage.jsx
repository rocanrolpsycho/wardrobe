import { useCallback, useEffect, useState } from "react";
import { Basket, CalendarCheck, Check, X } from "@phosphor-icons/react";

const API = "/api/usage";
const DAY_MS = 24 * 60 * 60 * 1000;

export const STATUS_LABELS = {
  available: "Available",
  laundry: "In the laundry",
  unavailable: "Unavailable",
};

// Pieces that usually go to the wash after one wear.
const WASH_AFTER_WEAR = new Set(["upperbody", "lowerbody"]);

export function todayKey(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function dayToDate(day) {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  return new Date(year, month - 1, dayOfMonth);
}

export function daysBetween(fromDay, toDay = todayKey()) {
  return Math.round((dayToDate(toDay) - dayToDate(fromDay)) / DAY_MS);
}

export function emptyUsage() {
  return { wears: [], status: "available", statusSince: null };
}

export function lastWorn(usage) {
  return usage?.wears?.length ? usage.wears[usage.wears.length - 1] : null;
}

export function describeDaysAgo(days) {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "about a month ago" : `about ${months} months ago`;
}

function formatDay(day) {
  return dayToDate(day).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json" } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "Could not update usage.");
  return value;
}

export function useUsage() {
  const [usage, setUsage] = useState({});
  const [error, setError] = useState("");

  useEffect(() => {
    request(API).then(setUsage).catch((requestError) => setError(requestError.message));
  }, []);

  const apply = useCallback(async (id, path, options) => {
    setError("");
    try {
      const updated = await request(`${API}/${encodeURIComponent(id)}/${path}`, options);
      setUsage((current) => ({ ...current, [id]: updated }));
    } catch (requestError) { setError(requestError.message); }
  }, []);

  const logWear = useCallback((id, date, toLaundry) => apply(id, "wear", { method: "POST", body: JSON.stringify({ date, toLaundry }) }), [apply]);
  const removeWear = useCallback((id, date) => apply(id, "wear", { method: "DELETE", body: JSON.stringify({ date }) }), [apply]);
  const setStatus = useCallback((id, status) => apply(id, "status", { method: "PUT", body: JSON.stringify({ status }) }), [apply]);
  const finishLaundry = useCallback(async () => {
    setError("");
    try {
      const { cleaned } = await request(`${API}/laundry/done`, { method: "POST" });
      const since = new Date().toISOString();
      setUsage((current) => {
        const next = { ...current };
        for (const id of cleaned) next[id] = { ...next[id], status: "available", statusSince: since };
        return next;
      });
    } catch (requestError) { setError(requestError.message); }
  }, []);

  return { usage, error, logWear, removeWear, setStatus, finishLaundry };
}

// Items not worn for at least `minDays`, oldest first. Never-worn pieces count from
// when they were added; pieces with no known date go first.
export function rediscoverList(items, usage, minDays) {
  return items
    .filter((item) => (usage[item.id]?.status || "available") === "available")
    .map((item) => {
      const last = lastWorn(usage[item.id]);
      const since = last || (item.addedAt ? todayKey(new Date(item.addedAt)) : null);
      return { item, last, idleDays: since ? daysBetween(since) : null };
    })
    .filter(({ idleDays }) => idleDays === null || idleDays >= minDays)
    .sort((a, b) => (b.idleDays ?? Infinity) - (a.idleDays ?? Infinity));
}

export function idleLabel({ last, idleDays }) {
  if (!last) return idleDays === null ? "Never worn" : `Never worn · added ${describeDaysAgo(idleDays)}`;
  return `Last worn ${describeDaysAgo(idleDays)}`;
}

export function UsagePanel({ item, usage = emptyUsage(), onLogWear, onRemoveWear, onSetStatus }) {
  const [date, setDate] = useState(todayKey());
  const [toLaundry, setToLaundry] = useState(WASH_AFTER_WEAR.has(item.part));
  const [showAll, setShowAll] = useState(false);
  const last = lastWorn(usage);
  const history = [...usage.wears].reverse();
  const visibleHistory = showAll ? history : history.slice(0, 6);
  const today = todayKey();

  useEffect(() => {
    setDate(todayKey());
    setToLaundry(WASH_AFTER_WEAR.has(item.part));
    setShowAll(false);
  }, [item.id, item.part]);

  return (
    <section className="usage-panel" aria-label="Wear history and availability">
      <div className="usage-summary">
        <span className="usage-label">Wear</span>
        <p>
          {usage.wears.length
            ? <>Worn <strong>{usage.wears.length}</strong> {usage.wears.length === 1 ? "time" : "times"} · last {describeDaysAgo(daysBetween(last))}</>
            : "Not worn yet"}
        </p>
      </div>

      <div className="usage-log-row">
        <input type="date" value={date} max={today} onChange={(event) => setDate(event.target.value)} aria-label="Day worn" />
        <button className="primary-button" type="button" disabled={!date || date > today} onClick={() => onLogWear(item.id, date, toLaundry)}>
          <CalendarCheck size={15} aria-hidden="true" /> {date === today ? "Wore it today" : "Log this day"}
        </button>
      </div>
      <label className="usage-check">
        <input type="checkbox" checked={toLaundry} onChange={(event) => setToLaundry(event.target.checked)} />
        Send to the laundry after logging
      </label>

      {!!history.length && (
        <ul className="usage-history">
          {visibleHistory.map((day, index) => (
            <li key={`${day}-${index}`}>
              <span>{formatDay(day)}</span>
              <button type="button" onClick={() => onRemoveWear(item.id, day)} aria-label={`Remove wear on ${formatDay(day)}`}><X size={12} aria-hidden="true" /></button>
            </li>
          ))}
          {history.length > visibleHistory.length && <li><button className="usage-more" type="button" onClick={() => setShowAll(true)}>Show all {history.length}</button></li>}
        </ul>
      )}

      <div className="usage-summary">
        <span className="usage-label">Availability</span>
      </div>
      <div className="usage-status" role="radiogroup" aria-label="Availability">
        {Object.entries(STATUS_LABELS).map(([status, label]) => (
          <button
            key={status}
            type="button"
            role="radio"
            aria-checked={usage.status === status}
            className={usage.status === status ? "active" : ""}
            onClick={() => onSetStatus(item.id, status)}
          >
            {status === "laundry" ? <Basket size={14} aria-hidden="true" /> : status === "available" ? <Check size={14} aria-hidden="true" /> : null}
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

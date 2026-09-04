import React, { useState, useMemo, useEffect, useRef } from "react";
import { SpeedInsights } from "@vercel/speed-insights/next"
// ---------------------------------------------------------------
// Point this at wherever server.js is actually running. Locally
// that's http://localhost:4000 by default; change it once you
// deploy the backend somewhere reachable from the browser.
// ---------------------------------------------------------------
const API_BASE = "http://localhost:4000/api";
const SYNC_INTERVAL_MS = 60000;
const SOURCE_COUNT = 5; // company boards the backend polls — see server.js JOB_SOURCES

// ---------- Personal, client-only storage (just enough to remember who you are) ----------
const TOKEN_KEY = "bluprint:authToken";
const KNOWN_JOBS_KEY = "bluprint:knownJobIds";

const EMPTY_PROFILE = { name: "", email: "", phone: "", headline: "", location: "", resumeUrl: "", skills: "" };

// ---------- API helpers ----------
async function api(path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const err = new Error(detail.error || `${method} ${path} failed with ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function safeStorageGet(key) {
  try {
    const result = await window.storage.get(key, false);
    return result?.value ? JSON.parse(result.value) : null;
  } catch (err) {
    return null;
  }
}
async function safeStorageSet(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value), false);
    return true;
  } catch (err) {
    return false;
  }
}

function jobMatchesQuery(job, query) {
  const matchesSearch =
    !query.search ||
    job.title.toLowerCase().includes(query.search.toLowerCase()) ||
    job.company.toLowerCase().includes(query.search.toLowerCase());
  const matchesCategory = query.category === "All" || job.category === query.category;
  const matchesRemote = !query.remoteOnly || job.remote;
  return matchesSearch && matchesCategory && matchesRemote;
}

const fmtSalary = (n) => `$${Math.round(n / 1000)}k`;

// ---------- Small building blocks ----------
function CornerBracket() {
  return (
    <>
      <span className="kb-corner kb-corner-tl" />
      <span className="kb-corner kb-corner-tr" />
      <span className="kb-corner kb-corner-bl" />
      <span className="kb-corner kb-corner-br" />
    </>
  );
}

function SpecField({ index, label, children }) {
  return (
    <div className="kb-spec-field">
      <div className="kb-spec-index">{String(index).padStart(2, "0")}</div>
      <div className="kb-spec-body">
        <label className="kb-spec-label">{label}</label>
        {children}
      </div>
    </div>
  );
}

function BookmarkIcon({ filled }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M3 1.5H11V12.5L7 10L3 12.5V1.5Z" stroke="currentColor" strokeWidth="1.3" fill={filled ? "currentColor" : "none"} />
    </svg>
  );
}

function SyncIndicator({ status, lastSynced, errorMessage }) {
  const label = status === "live" ? "Live" : status === "offline" ? "Offline" : "Connecting…";
  const timeStr = lastSynced
    ? new Date(lastSynced).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  const title = status === "offline" ? errorMessage || "Could not reach the Bluprint backend" : `Backend polls ${SOURCE_COUNT} company job boards every ${SYNC_INTERVAL_MS / 1000}s`;
  return (
    <div className={`kb-sync kb-sync-${status}`} title={title}>
      <span className="kb-sync-dot" />
      <span>{label}</span>
      {status === "live" && <span className="kb-sync-time">synced {timeStr}</span>}
    </div>
  );
}

function JobCard({ job, isNew, isSaved, onOpen, onToggleSave }) {
  return (
    <div className="kb-card">
      <CornerBracket />
      <button className="kb-card-save" onClick={(e) => { e.stopPropagation(); onToggleSave(job.id); }} title={isSaved ? "Remove from saved" : "Save job"}>
        <BookmarkIcon filled={isSaved} />
      </button>
      <button className="kb-card-hit" onClick={() => onOpen(job.id)}>
        <div className="kb-card-top">
          <span className="kb-code">{job.id.slice(0, 10)}</span>
          <span className="kb-posted">{isNew && <span className="kb-new-tag">NEW</span>} {job.posted}</span>
        </div>
        <h3>{job.title}</h3>
        <div className="kb-company">{job.company}</div>
        <div className="kb-tags">
          <span className="kb-tag">{job.location}</span>
          <span className="kb-tag">{job.type}</span>
          <span className="kb-tag">{job.category}</span>
        </div>
        <div className="kb-card-bottom">
          <span className="kb-salary">
            {job.salaryMin && job.salaryMax ? `${fmtSalary(job.salaryMin)}–${fmtSalary(job.salaryMax)}` : "See listing for pay"}
          </span>
          <span className="kb-view-link">VIEW SPEC →</span>
        </div>
      </button>
    </div>
  );
}

// ---------- Main App ----------
export default function App() {
  const [token, setToken] = useState(null);
  const [userId, setUserId] = useState(null);
  const [authed, setAuthed] = useState(false);
  const [authChecked, setAuthChecked] = useState(false); // true once we've resolved any stored token
  const [bootError, setBootError] = useState(null);

  const [jobs, setJobs] = useState([]);
  const [syncStatus, setSyncStatus] = useState("connecting");
  const [lastSynced, setLastSynced] = useState(null);
  const [syncError, setSyncError] = useState(null);
  const [sessionNewIds, setSessionNewIds] = useState(() => new Set());
  const initialKnownIdsRef = useRef(new Set());

  const [profile, setProfile] = useState(EMPTY_PROFILE);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [savedJobIds, setSavedJobIds] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [applications, setApplications] = useState([]);

  const [view, setView] = useState("browse");
  const [selectedId, setSelectedId] = useState(null);
  const [lastRef, setLastRef] = useState(null);
  const [returnToJobId, setReturnToJobId] = useState(null);
  const [pendingView, setPendingView] = useState(null); // where to land after a successful login/signup
  const [authMode, setAuthMode] = useState("login"); // "login" | "signup", shown in AuthView

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [remoteOnly, setRemoteOnly] = useState(false);

  const [applyForm, setApplyForm] = useState({ name: "", email: "", phone: "", link: "", note: "" });

  const profileComplete = Boolean(profile.name && profile.email);

  // Loads everything that depends on being logged in. Called both after
  // a successful login/signup and after verifying a stored token on boot.
  async function loadPersonalData(nextToken) {
    const [profileRes, savedRes, alertsRes, appsRes] = await Promise.all([
      api("/profile", { token: nextToken }),
      api("/saved", { token: nextToken }),
      api("/alerts", { token: nextToken }),
      api("/applications", { token: nextToken }),
    ]);
    setProfile({ ...EMPTY_PROFILE, ...profileRes });
    setSavedJobIds(savedRes || []);
    setAlerts(alertsRes || []);
    setApplications(appsRes || []);
    setProfileLoaded(true);
  }

  function requireAuthOr(action) {
    if (authed) return action();
    setPendingView(view);
    setAuthMode("login");
    setView("auth");
  }

  async function handleAuthSuccess({ userId: newUserId, token: newToken, profile: newProfile }) {
    await safeStorageSet(TOKEN_KEY, newToken);
    setToken(newToken);
    setUserId(newUserId);
    setAuthed(true);
    setProfile({ ...EMPTY_PROFILE, ...newProfile });
    try {
      const [savedRes, alertsRes, appsRes] = await Promise.all([
        api("/saved", { token: newToken }),
        api("/alerts", { token: newToken }),
        api("/applications", { token: newToken }),
      ]);
      setSavedJobIds(savedRes || []);
      setAlerts(alertsRes || []);
      setApplications(appsRes || []);
    } catch (err) {
      // Non-fatal — profile is loaded, personal lists just stay empty until next refresh.
    }
    setProfileLoaded(true);
    setView(pendingView || "browse");
    setPendingView(null);
  }

  async function logOut() {
    await window.storage.delete(TOKEN_KEY, false).catch(() => {});
    setToken(null);
    setUserId(null);
    setAuthed(false);
    setProfile(EMPTY_PROFILE);
    setProfileLoaded(false);
    setSavedJobIds([]);
    setAlerts([]);
    setApplications([]);
    setView("browse");
  }

  async function syncJobs() {
    try {
      const data = await api("/jobs");
      const fetched = data.jobs || [];
      const newIds = fetched.filter((j) => !initialKnownIdsRef.current.has(j.id)).map((j) => j.id);
      if (newIds.length) setSessionNewIds((prev) => new Set([...prev, ...newIds]));
      setJobs(fetched);
      setSyncStatus(data.status === "live" ? "live" : data.jobs?.length ? "live" : "offline");
      setLastSynced(data.syncedAt || new Date().toISOString());
      const unionIds = Array.from(new Set([...initialKnownIdsRef.current, ...fetched.map((j) => j.id)]));
      safeStorageSet(KNOWN_JOBS_KEY, unionIds);
    } catch (err) {
      setSyncStatus("offline");
      setSyncError(err.message);
    }
  }

  // ---- Boot: verify any stored session token, load personal data if logged
  // in, and start job polling (jobs are public — no login required to browse). ----
  useEffect(() => {
    let cancelled = false;
    let interval;

    async function init() {
      try {
        const knownIds = await safeStorageGet(KNOWN_JOBS_KEY);
        if (Array.isArray(knownIds)) initialKnownIdsRef.current = new Set(knownIds);

        const storedToken = await safeStorageGet(TOKEN_KEY);
        if (storedToken) {
          try {
            const me = await api("/auth/me", { token: storedToken });
            if (cancelled) return;
            setToken(storedToken);
            setUserId(me.userId);
            setAuthed(true);
            setProfile({ ...EMPTY_PROFILE, ...me.profile });
            await loadPersonalData(storedToken);
          } catch (err) {
            // Stored token is expired/invalid — drop it and fall back to logged-out browsing.
            await window.storage.delete(TOKEN_KEY, false).catch(() => {});
          }
        }
      } catch (err) {
        if (!cancelled) setBootError(err.message);
      } finally {
        if (!cancelled) setAuthChecked(true);
      }

      await syncJobs();
      if (cancelled) return;
      interval = setInterval(() => {
        if (!cancelled) syncJobs();
      }, SYNC_INTERVAL_MS);
    }

    init();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const availableCategories = useMemo(() => Array.from(new Set(jobs.map((j) => j.category))).sort(), [jobs]);

  const filteredJobs = useMemo(() => {
    return jobs.filter((j) => jobMatchesQuery(j, { search, category: categoryFilter, remoteOnly }));
  }, [jobs, search, categoryFilter, remoteOnly]);

  const savedJobs = useMemo(() => jobs.filter((j) => savedJobIds.includes(j.id)), [jobs, savedJobIds]);
  const selectedJob = jobs.find((j) => j.id === selectedId);

  const totalNewMatches = useMemo(() => {
    if (sessionNewIds.size === 0) return 0;
    return jobs.filter((j) => sessionNewIds.has(j.id)).length;
  }, [jobs, sessionNewIds]);

  function openJob(id) {
    setSelectedId(id);
    setView("detail");
  }

  function toggleSaved(jobId) {
    requireAuthOr(async () => {
      const isSaved = savedJobIds.includes(jobId);
      setSavedJobIds((prev) => (isSaved ? prev.filter((id) => id !== jobId) : [...prev, jobId]));
      try {
        const updated = isSaved
          ? await api(`/saved/${encodeURIComponent(jobId)}`, { method: "DELETE", token })
          : await api("/saved", { method: "POST", token, body: { jobId } });
        setSavedJobIds(updated);
      } catch (err) {
        setSavedJobIds((prev) => (isSaved ? [...prev, jobId] : prev.filter((id) => id !== jobId)));
      }
    });
  }

  async function logApplication(payload) {
    try {
      const record = await api("/applications", { method: "POST", token, body: payload });
      setApplications((prev) => [record, ...prev]);
      setLastRef(record.ref);
      return record;
    } catch (err) {
      setSyncError(err.message);
      return null;
    }
  }

  function quickApply(job) {
    requireAuthOr(async () => {
      if (!profileComplete) {
        setReturnToJobId(job.id);
        setView("profile");
        return;
      }
      window.open(job.sourceUrl, "_blank", "noopener,noreferrer");
      await logApplication({
        jobId: job.id,
        jobTitle: job.title,
        company: job.company,
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        link: profile.resumeUrl,
        note: "Quick Apply — used saved profile",
      });
      setSelectedId(job.id);
      setView("confirm");
    });
  }

  function startManualLog() {
    requireAuthOr(() => {
      setApplyForm({ name: profile.name || "", email: profile.email || "", phone: profile.phone || "", link: profile.resumeUrl || "", note: "" });
      setView("apply");
    });
  }

  async function submitApplication(e) {
    e.preventDefault();
    await logApplication({
      jobId: selectedJob.id,
      jobTitle: selectedJob.title,
      company: selectedJob.company,
      ...applyForm,
    });
    setView("confirm");
  }

  async function saveProfile(next) {
    try {
      const saved = await api("/profile", { method: "PUT", token, body: next });
      setProfile({ ...EMPTY_PROFILE, ...saved });
      if (returnToJobId) {
        setSelectedId(returnToJobId);
        setReturnToJobId(null);
        setView("detail");
      }
    } catch (err) {
      setSyncError(err.message);
    }
  }

  async function createAlert(name, query) {
    try {
      const updated = await api("/alerts", { method: "POST", token, body: { name, query } });
      setAlerts(updated);
    } catch (err) {
      setSyncError(err.message);
    }
  }

  async function deleteAlert(id) {
    try {
      const updated = await api(`/alerts/${encodeURIComponent(id)}`, { method: "DELETE", token });
      setAlerts(updated);
    } catch (err) {
      setSyncError(err.message);
    }
  }

  function viewAlertMatches(alert) {
    setSearch(alert.query.search || "");
    setCategoryFilter(alert.query.category || "All");
    setRemoteOnly(Boolean(alert.query.remoteOnly));
    setView("browse");
  }

  return (
    <div className="kb-root">
      <style>{CSS}</style>

      <header className="kb-header">
        <div className="kb-header-inner">
          <button className="kb-logo" onClick={() => setView("browse")}>
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
              <path d="M13 2 L24 13 L13 24 L2 13 Z" stroke="#F2A65A" strokeWidth="1.4" />
              <path d="M13 2 V24 M2 13 H24" stroke="#5EC8D8" strokeWidth="0.7" strokeDasharray="2 2" />
            </svg>
            <span>BLUPRINT</span>
          </button>
          <nav className="kb-nav">
            <button className={view === "browse" || view === "detail" || view === "apply" || view === "confirm" ? "active" : ""} onClick={() => setView("browse")}>Find work</button>
            <button className={view === "saved" ? "active" : ""} onClick={() => requireAuthOr(() => setView("saved"))}>
              Saved {savedJobIds.length > 0 && <span className="kb-badge">{savedJobIds.length}</span>}
            </button>
            <button className={view === "alerts" ? "active" : ""} onClick={() => requireAuthOr(() => setView("alerts"))}>
              Alerts {totalNewMatches > 0 && <span className="kb-badge">{totalNewMatches}</span>}
            </button>
            <button className={view === "applications" ? "active" : ""} onClick={() => requireAuthOr(() => setView("applications"))}>
              Applications {applications.length > 0 && <span className="kb-badge">{applications.length}</span>}
            </button>
            <button className={view === "profile" ? "active" : ""} onClick={() => requireAuthOr(() => setView("profile"))}>
              Profile {!profileComplete && profileLoaded && <span className="kb-dot" />}
            </button>
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {authed ? (
              <button className="kb-btn-secondary kb-btn-sm" onClick={logOut} title={profile.email}>Log out</button>
            ) : (
              <button className="kb-btn-secondary kb-btn-sm" onClick={() => { setAuthMode("login"); setPendingView(null); setView("auth"); }}>Sign in</button>
            )}
            <SyncIndicator status={syncStatus} lastSynced={lastSynced} errorMessage={syncError} />
          </div>
        </div>
      </header>

      {bootError && (
        <div className="kb-boot-error">
          Couldn't reach the Bluprint backend at <code>{API_BASE}</code>. Make sure <code>node server.js</code> is running, then reload. ({bootError})
        </div>
      )}

      <main className="kb-main">
        {view === "browse" && (
          <BrowseView
            jobs={filteredJobs}
            total={jobs.length}
            syncStatus={syncStatus}
            syncError={syncError}
            search={search}
            setSearch={setSearch}
            categoryFilter={categoryFilter}
            setCategoryFilter={setCategoryFilter}
            availableCategories={availableCategories}
            remoteOnly={remoteOnly}
            setRemoteOnly={setRemoteOnly}
            openJob={openJob}
            savedJobIds={savedJobIds}
            toggleSaved={toggleSaved}
            sessionNewIds={sessionNewIds}
            onSaveAlert={() => requireAuthOr(() => createAlert(search || categoryFilter !== "All" ? `${categoryFilter !== "All" ? categoryFilter : "All"}${search ? " · " + search : ""}${remoteOnly ? " · Remote" : ""}` : "All new jobs", { search, category: categoryFilter, remoteOnly }))}
          />
        )}

        {view === "detail" && selectedJob && (
          <DetailView
            job={selectedJob}
            onBack={() => setView("browse")}
            onQuickApply={() => quickApply(selectedJob)}
            onManualLog={startManualLog}
            isSaved={savedJobIds.includes(selectedJob.id)}
            onToggleSave={() => toggleSaved(selectedJob.id)}
            profileComplete={profileComplete}
          />
        )}

        {view === "apply" && selectedJob && (
          <ApplyView job={selectedJob} form={applyForm} setForm={setApplyForm} onSubmit={submitApplication} onCancel={() => setView("detail")} />
        )}

        {view === "confirm" && selectedJob && <ConfirmView job={selectedJob} refCode={lastRef} onBrowse={() => setView("browse")} />}

        {view === "saved" && (
          <SavedView jobs={savedJobs} openJob={openJob} savedJobIds={savedJobIds} toggleSaved={toggleSaved} sessionNewIds={sessionNewIds} onBrowse={() => setView("browse")} />
        )}

        {view === "alerts" && (
          <AlertsView alerts={alerts} jobs={jobs} sessionNewIds={sessionNewIds} onCreate={createAlert} onDelete={deleteAlert} onViewMatches={viewAlertMatches} availableCategories={availableCategories} />
        )}

        {view === "applications" && <ApplicationsView applications={applications} onOpenJob={openJob} />}

        {view === "profile" && <ProfileView profile={profile} onSave={saveProfile} profileComplete={profileComplete} returnToJobId={returnToJobId} />}

        {view === "auth" && (
          <AuthView
            mode={authMode}
            setMode={setAuthMode}
            onSuccess={handleAuthSuccess}
            onCancel={() => { setPendingView(null); setView("browse"); }}
          />
        )}
      </main>

      <footer className="kb-footer">
        <span>BLUPRINT — DRAFT NO. 4471</span>
        <span>{jobs.length} LISTINGS VIA BACKEND · {SOURCE_COUNT} COMPANY BOARDS</span>
      </footer>
    </div>
  );
}

// ---------- Browse ----------
function BrowseView({ jobs, total, syncStatus, syncError, search, setSearch, categoryFilter, setCategoryFilter, availableCategories, remoteOnly, setRemoteOnly, openJob, savedJobIds, toggleSaved, sessionNewIds, onSaveAlert }) {
  return (
    <div className="kb-page">
      <section className="kb-hero">
        <div className="kb-hero-eyebrow">SPEC SHEET — LIVE CAREER PLACEMENT</div>
        <h1>Every good career<br />has a blueprint.</h1>
        <p className="kb-hero-sub">
          {syncStatus === "connecting"
            ? "Connecting to the Bluprint backend…"
            : `${total} openings, served by the Bluprint API and fetched live from each company's own job board.`}
        </p>
        <svg className="kb-hero-diagram" viewBox="0 0 640 90" preserveAspectRatio="none">
          <line x1="0" y1="45" x2="640" y2="45" stroke="#2B4C6F" strokeWidth="1" />
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <line key={i} x1={i * 106.6} y1="38" x2={i * 106.6} y2="52" stroke="#2B4C6F" strokeWidth="1" />
          ))}
          <circle cx="40" cy="45" r="4" fill="#5EC8D8" />
          <circle cx="320" cy="45" r="4" fill="#F2A65A" />
          <circle cx="600" cy="45" r="4" fill="#5EC8D8" />
          <text x="40" y="72" fill="#93A8BE" fontSize="11" fontFamily="IBM Plex Mono, monospace" textAnchor="middle">START</text>
          <text x="320" y="72" fill="#F2A65A" fontSize="11" fontFamily="IBM Plex Mono, monospace" textAnchor="middle">YOU ARE HERE</text>
          <text x="600" y="72" fill="#93A8BE" fontSize="11" fontFamily="IBM Plex Mono, monospace" textAnchor="middle">OFFER</text>
        </svg>
      </section>

      <section className="kb-filters">
        <input className="kb-input" placeholder="Search title or company…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="kb-pills">
          <button className={categoryFilter === "All" ? "kb-pill active" : "kb-pill"} onClick={() => setCategoryFilter("All")}>All</button>
          {availableCategories.map((c) => (
            <button key={c} className={categoryFilter === c ? "kb-pill active" : "kb-pill"} onClick={() => setCategoryFilter(c)}>{c}</button>
          ))}
        </div>
        <label className="kb-checkbox">
          <input type="checkbox" checked={remoteOnly} onChange={(e) => setRemoteOnly(e.target.checked)} />
          Remote only
        </label>
        <button className="kb-btn-secondary kb-btn-sm" onClick={onSaveAlert}>+ Save as alert</button>
      </section>

      <section className="kb-grid">
        {syncStatus === "connecting" && <div className="kb-empty kb-empty-lg">Connecting to the Bluprint backend…</div>}
        {syncStatus === "offline" && (
          <div className="kb-empty kb-empty-lg">
            Couldn't reach the Bluprint API right now{syncError ? ` (${syncError})` : ""}. Make sure <code>node server.js</code> is running at {API_BASE}. It'll retry automatically.
          </div>
        )}
        {syncStatus === "live" && jobs.length === 0 && <div className="kb-empty">No open positions match that spec right now. Try clearing a filter.</div>}
        {jobs.map((j) => (
          <JobCard key={j.id} job={j} isNew={sessionNewIds.has(j.id)} isSaved={savedJobIds.includes(j.id)} onOpen={openJob} onToggleSave={toggleSaved} />
        ))}
      </section>
    </div>
  );
}

// ---------- Saved ----------
function SavedView({ jobs, openJob, savedJobIds, toggleSaved, sessionNewIds, onBrowse }) {
  return (
    <div className="kb-page">
      <div className="kb-hero-eyebrow">SPEC SHEET — SAVED FOR LATER</div>
      <h1 className="kb-apps-title">Saved jobs</h1>
      {jobs.length === 0 ? (
        <div className="kb-empty kb-empty-lg">
          Nothing saved yet. Tap the bookmark on any listing to keep it here.
          <div style={{ marginTop: 14 }}>
            <button className="kb-btn-primary" onClick={onBrowse}>Browse listings</button>
          </div>
        </div>
      ) : (
        <section className="kb-grid">
          {jobs.map((j) => (
            <JobCard key={j.id} job={j} isNew={sessionNewIds.has(j.id)} isSaved={savedJobIds.includes(j.id)} onOpen={openJob} onToggleSave={toggleSaved} />
          ))}
        </section>
      )}
    </div>
  );
}

// ---------- Alerts ----------
function AlertsView({ alerts, jobs, sessionNewIds, onCreate, onDelete, onViewMatches, availableCategories }) {
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [remoteOnly, setRemoteOnly] = useState(false);

  function handleCreate(e) {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate(name.trim(), { search, category, remoteOnly });
    setName("");
    setSearch("");
    setCategory("All");
    setRemoteOnly(false);
  }

  return (
    <div className="kb-page kb-page-narrow">
      <div className="kb-hero-eyebrow">SPEC SHEET — JOB ALERTS</div>
      <h1 className="kb-apps-title">Job alerts</h1>
      <p className="kb-body-text" style={{ marginBottom: 20 }}>
        Save a search once and Bluprint flags new matches as they come in from the backend's live feed — checked every {SYNC_INTERVAL_MS / 1000} seconds while this app is open.
      </p>

      <div className="kb-detail-card" style={{ marginBottom: 24 }}>
        <CornerBracket />
        <h4 className="kb-section-label">NEW ALERT</h4>
        <form onSubmit={handleCreate} className="kb-spec-form">
          <SpecField index={1} label="Alert name">
            <input className="kb-input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Remote design roles" />
          </SpecField>
          <SpecField index={2} label="Keyword (optional)">
            <input className="kb-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. designer, backend" />
          </SpecField>
          <SpecField index={3} label="Category">
            <select className="kb-input" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option>All</option>
              {availableCategories.map((c) => <option key={c}>{c}</option>)}
            </select>
          </SpecField>
          <SpecField index={4} label="Remote only?">
            <label className="kb-checkbox">
              <input type="checkbox" checked={remoteOnly} onChange={(e) => setRemoteOnly(e.target.checked)} />
              Yes, only remote roles
            </label>
          </SpecField>
          <button type="submit" className="kb-btn-primary kb-btn-full">Create alert</button>
        </form>
      </div>

      {alerts.length === 0 ? (
        <div className="kb-empty kb-empty-lg">No alerts yet — create one above.</div>
      ) : (
        <div className="kb-apps-list">
          {alerts.map((a) => {
            const matches = jobs.filter((j) => jobMatchesQuery(j, a.query));
            const newMatches = matches.filter((j) => sessionNewIds.has(j.id));
            return (
              <div key={a.id} className="kb-app-row kb-alert-row">
                <CornerBracket />
                <div className="kb-app-main">
                  <div className="kb-app-title" style={{ cursor: "default" }}>{a.name}</div>
                  <div className="kb-tags">
                    {a.query.category !== "All" && <span className="kb-tag">{a.query.category}</span>}
                    {a.query.search && <span className="kb-tag">"{a.query.search}"</span>}
                    {a.query.remoteOnly && <span className="kb-tag">Remote only</span>}
                  </div>
                </div>
                <div className="kb-alert-stats">
                  <span className="kb-source-note" style={{ margin: 0 }}>{matches.length} matching now{newMatches.length > 0 ? ` · ${newMatches.length} new` : ""}</span>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button className="kb-btn-secondary kb-btn-sm" onClick={() => onViewMatches(a)}>View matches</button>
                    <button className="kb-btn-secondary kb-btn-sm" onClick={() => onDelete(a.id)}>Delete</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- Detail ----------
function DetailView({ job, onBack, onQuickApply, onManualLog, isSaved, onToggleSave, profileComplete }) {
  return (
    <div className="kb-page kb-page-narrow">
      <button className="kb-back" onClick={onBack}>← Back to listings</button>
      <div className="kb-detail-card">
        <CornerBracket />
        <div className="kb-detail-header">
          <span className="kb-code">{job.id}</span>
          <span className="kb-posted">Posted {job.posted}</span>
        </div>
        <h1>{job.title}</h1>
        <div className="kb-company kb-company-lg">{job.company}</div>
        <div className="kb-tags">
          <span className="kb-tag">{job.location}</span>
          <span className="kb-tag">{job.type}</span>
          <span className="kb-tag">{job.category}</span>
          {job.salaryMin && job.salaryMax && <span className="kb-tag kb-tag-salary">{fmtSalary(job.salaryMin)}–{fmtSalary(job.salaryMax)} / yr</span>}
        </div>

        <div className="kb-divider" />
        <h4 className="kb-section-label">DESCRIPTION</h4>
        <p className="kb-body-text">{job.description}</p>

        {job.requirements.length > 0 && (
          <>
            <h4 className="kb-section-label">FROM THE LISTING</h4>
            <ul className="kb-req-list">
              {job.requirements.map((r, i) => (
                <li key={i}><span className="kb-req-index">{String(i + 1).padStart(2, "0")}</span>{r}</li>
              ))}
            </ul>
          </>
        )}

        <button className="kb-btn-primary kb-btn-full" onClick={onQuickApply}>
          {profileComplete ? `⚡ Quick Apply with your profile` : "Complete your profile to Quick Apply"}
        </button>
        <div className="kb-detail-actions">
          <button className="kb-btn-secondary" onClick={onToggleSave}>
            <BookmarkIcon filled={isSaved} /> {isSaved ? "Saved" : "Save for later"}
          </button>
          <button className="kb-btn-secondary" onClick={onManualLog}>Log manually instead</button>
        </div>
        <div className="kb-source-note">{job.sourceLabel} — refreshed by the backend every {SYNC_INTERVAL_MS / 1000}s. Quick Apply opens {job.company}'s real listing and logs it to your tracker.</div>
      </div>
    </div>
  );
}

// ---------- Apply / Tracker ----------
function ApplyView({ job, form, setForm, onSubmit, onCancel }) {
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="kb-page kb-page-narrow">
      <button className="kb-back" onClick={onCancel}>← Back to {job.title}</button>
      <div className="kb-detail-card">
        <CornerBracket />
        <div className="kb-detail-header">
          <span className="kb-code">TRACKER ENTRY</span>
          <span className="kb-posted">FOR {job.id}</span>
        </div>
        <h1>Log — {job.title}</h1>
        <div className="kb-company kb-company-lg">{job.company}</div>
        <p className="kb-body-text kb-tracker-note">
          This saves to your personal tracker only — it does not submit anything to {job.company}. Use this if you already applied elsewhere, or want custom notes for this one.
        </p>
        <div className="kb-divider" />
        <form onSubmit={onSubmit} className="kb-spec-form">
          <SpecField index={1} label="Full name"><input className="kb-input" required value={form.name} onChange={set("name")} placeholder="Jordan Alvarez" /></SpecField>
          <SpecField index={2} label="Email"><input className="kb-input" type="email" required value={form.email} onChange={set("email")} placeholder="jordan@example.com" /></SpecField>
          <SpecField index={3} label="Phone"><input className="kb-input" value={form.phone} onChange={set("phone")} placeholder="(713) 555-0148" /></SpecField>
          <SpecField index={4} label="Resume link or portfolio (URL)"><input className="kb-input" value={form.link} onChange={set("link")} placeholder="https://…" /></SpecField>
          <SpecField index={5} label="Note to self (optional)"><textarea className="kb-input kb-textarea" rows={5} value={form.note} onChange={set("note")} placeholder="Status, follow-up date, contact name…" /></SpecField>
          <button type="submit" className="kb-btn-primary kb-btn-full">Save to my tracker</button>
        </form>
      </div>
    </div>
  );
}

// ---------- Confirm ----------
function ConfirmView({ job, refCode, onBrowse }) {
  return (
    <div className="kb-page kb-page-narrow">
      <div className="kb-confirm-card">
        <CornerBracket />
        <svg width="44" height="44" viewBox="0 0 44 44" fill="none" style={{ marginBottom: 16 }}>
          <circle cx="22" cy="22" r="20" stroke="#F2A65A" strokeWidth="1.4" />
          <path d="M13 22 L19 28 L31 15" stroke="#F2A65A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h2>Saved to your tracker</h2>
        <p className="kb-body-text"><strong>{job.title}</strong> at <strong>{job.company}</strong> is now logged.</p>
        <div className="kb-ref-box">
          <span className="kb-section-label">REFERENCE</span>
          <span className="kb-ref-code">{refCode}</span>
        </div>
        {job.sourceUrl && (
          <a className="kb-btn-primary" href={job.sourceUrl} target="_blank" rel="noopener noreferrer">Go to original listing ↗</a>
        )}
        <button className="kb-btn-secondary" onClick={onBrowse} style={{ marginTop: 10 }}>Back to listings</button>
      </div>
    </div>
  );
}

// ---------- Applications ----------
function ApplicationsView({ applications, onOpenJob }) {
  return (
    <div className="kb-page">
      <div className="kb-hero-eyebrow">SPEC SHEET — TRACKED RECORDS</div>
      <h1 className="kb-apps-title">Applications you're tracking</h1>
      {applications.length === 0 ? (
        <div className="kb-empty kb-empty-lg">Nothing tracked yet. Quick Apply or log one manually from a listing.</div>
      ) : (
        <div className="kb-apps-list">
          {applications.map((a) => (
            <div key={a.ref} className="kb-app-row">
              <CornerBracket />
              <div className="kb-app-ref">{a.ref}</div>
              <div className="kb-app-main">
                <button className="kb-app-title" onClick={() => onOpenJob(a.jobId)}>{a.jobTitle}</button>
                <div className="kb-company">{a.company}</div>
                <div className="kb-tags">
                  <span className="kb-tag">{a.name}</span>
                  <span className="kb-tag">{a.email}</span>
                  {a.note && <span className="kb-tag">{a.note}</span>}
                </div>
              </div>
              <div className="kb-app-status">
                {typeof a.submitted === "string" && !Number.isNaN(Date.parse(a.submitted)) ? new Date(a.submitted).toLocaleDateString() : a.submitted}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Profile ----------
function ProfileView({ profile, onSave, profileComplete, returnToJobId }) {
  const [form, setForm] = useState(profile);
  useEffect(() => setForm(profile), [profile]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function handleSubmit(e) {
    e.preventDefault();
    onSave(form);
  }

  return (
    <div className="kb-page kb-page-narrow">
      <div className="kb-detail-card">
        <CornerBracket />
        <div className="kb-detail-header">
          <span className="kb-code">PROFILE SPEC</span>
          {profileComplete && <span className="kb-posted">QUICK APPLY READY</span>}
        </div>
        <h1>Your profile</h1>
        <p className="kb-body-text">
          {returnToJobId
            ? "Finish this so you can Quick Apply — you'll land back on that listing once it's saved."
            : "Saved on the Bluprint backend and reused for Quick Apply everywhere in the app."}
        </p>
        <div className="kb-divider" />
        <form onSubmit={handleSubmit} className="kb-spec-form">
          <SpecField index={1} label="Full name"><input className="kb-input" required value={form.name} onChange={set("name")} placeholder="Jordan Alvarez" /></SpecField>
          <SpecField index={2} label="Email"><input className="kb-input" type="email" required value={form.email} onChange={set("email")} placeholder="jordan@example.com" /></SpecField>
          <SpecField index={3} label="Phone"><input className="kb-input" value={form.phone} onChange={set("phone")} placeholder="(713) 555-0148" /></SpecField>
          <SpecField index={4} label="Headline / current title"><input className="kb-input" value={form.headline} onChange={set("headline")} placeholder="Backend engineer, 4 yrs" /></SpecField>
          <SpecField index={5} label="Location"><input className="kb-input" value={form.location} onChange={set("location")} placeholder="Houston, TX" /></SpecField>
          <SpecField index={6} label="Resume or portfolio link"><input className="kb-input" value={form.resumeUrl} onChange={set("resumeUrl")} placeholder="https://…" /></SpecField>
          <SpecField index={7} label="Skills (comma-separated)"><textarea className="kb-input kb-textarea" rows={3} value={form.skills} onChange={set("skills")} placeholder="Go, distributed systems, Figma…" /></SpecField>
          <button type="submit" className="kb-btn-primary kb-btn-full">Save profile</button>
        </form>
      </div>
    </div>
  );
}

// ---------- Auth ----------
function AuthView({ mode, setMode, onSuccess, onCancel }) {
  const isSignup = mode === "signup";
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (isSignup && form.password !== form.confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const result = isSignup
        ? await api("/auth/signup", { method: "POST", body: { email: form.email, password: form.password, name: form.name } })
        : await api("/auth/login", { method: "POST", body: { email: form.email, password: form.password } });
      await onSuccess(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="kb-page kb-page-narrow">
      <button className="kb-back" onClick={onCancel}>← Back to listings</button>
      <div className="kb-detail-card">
        <CornerBracket />
        <div className="kb-detail-header">
          <span className="kb-code">{isSignup ? "NEW ACCOUNT" : "SIGN IN"}</span>
        </div>
        <h1>{isSignup ? "Create your account" : "Welcome back"}</h1>
        <p className="kb-body-text">
          {isSignup
            ? "Needed for saved jobs, Quick Apply, alerts, and your application tracker."
            : "Sign in to get back to your saved jobs, profile, and tracked applications."}
        </p>
        <div className="kb-divider" />
        <form onSubmit={handleSubmit} className="kb-spec-form">
          {isSignup && (
            <SpecField index={1} label="Full name">
              <input className="kb-input" value={form.name} onChange={set("name")} placeholder="Jordan Alvarez" />
            </SpecField>
          )}
          <SpecField index={isSignup ? 2 : 1} label="Email">
            <input className="kb-input" type="email" required autoComplete="email" value={form.email} onChange={set("email")} placeholder="jordan@example.com" />
          </SpecField>
          <SpecField index={isSignup ? 3 : 2} label="Password">
            <input
              className="kb-input"
              type="password"
              required
              minLength={isSignup ? 8 : undefined}
              autoComplete={isSignup ? "new-password" : "current-password"}
              value={form.password}
              onChange={set("password")}
              placeholder={isSignup ? "At least 8 characters" : "••••••••"}
            />
          </SpecField>
          {isSignup && (
            <SpecField index={4} label="Confirm password">
              <input className="kb-input" type="password" required autoComplete="new-password" value={form.confirm} onChange={set("confirm")} placeholder="••••••••" />
            </SpecField>
          )}
          {error && <div className="kb-source-note" style={{ color: "var(--amber)", textAlign: "left" }}>{error}</div>}
          <button type="submit" className="kb-btn-primary kb-btn-full" disabled={submitting}>
            {submitting ? "One moment…" : isSignup ? "Create account" : "Sign in"}
          </button>
        </form>
        <p className="kb-body-text" style={{ marginTop: 16, fontSize: 13 }}>
          {isSignup ? "Already have an account?" : "Don't have an account yet?"}{" "}
          <button
            type="button"
            className="kb-back"
            style={{ display: "inline", margin: 0, color: "var(--cyan)" }}
            onClick={() => { setError(null); setMode(isSignup ? "login" : "signup"); }}
          >
            {isSignup ? "Sign in instead" : "Create one"}
          </button>
        </p>
      </div>
    </div>
  );
}

// ---------- CSS ----------
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap');

.kb-root {
  --bg: #0E2238;
  --surface: #163454;
  --line: #2B4C6F;
  --ink: #E8EDF2;
  --muted: #93A8BE;
  --cyan: #5EC8D8;
  --amber: #F2A65A;
  background: var(--bg);
  background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
  background-size: 32px 32px;
  color: var(--ink);
  font-family: 'IBM Plex Sans', sans-serif;
  min-height: 100%;
  width: 100%;
}
.kb-root * { box-sizing: border-box; }

.kb-boot-error {
  max-width: 1120px; margin: 12px auto 0; padding: 12px 20px;
  font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #F2A65A;
  border: 1px dashed #F2A65A; border-radius: 4px; background: rgba(242,166,90,0.08);
}
.kb-boot-error code { color: #E8EDF2; }

.kb-header { position: sticky; top: 0; z-index: 10; background: rgba(14,34,56,0.92); backdrop-filter: blur(6px); border-bottom: 1px solid var(--line); }
.kb-header-inner { max-width: 1120px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.kb-logo { display: flex; align-items: center; gap: 8px; background: none; border: none; cursor: pointer; font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 16px; letter-spacing: 0.08em; color: var(--ink); }
.kb-nav { display: flex; gap: 2px; flex-wrap: wrap; }
.kb-nav button { background: none; border: none; color: var(--muted); font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.03em; padding: 8px 11px; cursor: pointer; border-radius: 3px; display: flex; align-items: center; gap: 5px; }
.kb-nav button:hover { color: var(--ink); background: var(--surface); }
.kb-nav button.active { color: var(--amber); }
.kb-badge { background: var(--amber); color: var(--bg); font-size: 10px; padding: 1px 6px; border-radius: 10px; font-weight: 700; }
.kb-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); }
.kb-sync { display: flex; align-items: center; gap: 6px; font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: var(--muted); padding: 4px 10px; border: 1px solid var(--line); border-radius: 20px; }
.kb-sync-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
.kb-sync-live .kb-sync-dot { background: #6FCF97; box-shadow: 0 0 0 2px rgba(111,207,151,0.2); }
.kb-sync-offline .kb-sync-dot { background: var(--amber); }
.kb-sync-time { color: var(--line); }

.kb-main { max-width: 1120px; margin: 0 auto; padding: 0 20px 60px; }
.kb-page { padding-top: 36px; }
.kb-page-narrow { max-width: 620px; margin: 0 auto; padding-top: 36px; }

.kb-hero { padding: 20px 0 12px; }
.kb-hero-eyebrow { font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.12em; color: var(--cyan); margin-bottom: 14px; }
.kb-hero h1 { font-family: 'Space Grotesk', sans-serif; font-size: 42px; line-height: 1.1; font-weight: 700; margin: 0 0 14px; }
.kb-hero-sub { color: var(--muted); font-size: 15px; max-width: 560px; margin: 0 0 20px; }
.kb-hero-diagram { width: 100%; height: 70px; }

.kb-filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 8px 0 28px; }
.kb-input { background: var(--surface); border: 1px solid var(--line); color: var(--ink); font-family: 'IBM Plex Sans', sans-serif; font-size: 14px; padding: 10px 12px; border-radius: 3px; width: 100%; }
.kb-input:focus { outline: none; border-color: var(--cyan); }
.kb-filters > .kb-input { max-width: 260px; }
.kb-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.kb-pill { background: transparent; border: 1px solid var(--line); color: var(--muted); font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.03em; padding: 7px 12px; border-radius: 20px; cursor: pointer; }
.kb-pill:hover { border-color: var(--cyan); color: var(--ink); }
.kb-pill.active { background: var(--amber); border-color: var(--amber); color: var(--bg); font-weight: 600; }
.kb-checkbox { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; cursor: pointer; }

.kb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.kb-empty { color: var(--muted); font-size: 14px; grid-column: 1 / -1; padding: 40px 0; text-align: center; }
.kb-empty-lg { padding: 80px 20px; border: 1px dashed var(--line); border-radius: 4px; }
.kb-empty-lg code { color: var(--amber); }

.kb-card { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 2px; }
.kb-card:hover { border-color: var(--cyan); transform: translateY(-1px); }
.kb-card-hit { display: flex; flex-direction: column; gap: 10px; padding: 18px; text-align: left; cursor: pointer; background: none; border: none; color: inherit; font-family: inherit; width: 100%; }
.kb-card-save { position: absolute; top: 14px; right: 14px; z-index: 2; background: none; border: none; color: var(--muted); cursor: pointer; padding: 4px; }
.kb-card-save:hover { color: var(--amber); }
.kb-card-top, .kb-detail-header { display: flex; justify-content: space-between; align-items: center; }
.kb-code { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--amber); letter-spacing: 0.05em; }
.kb-posted { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.kb-new-tag { background: var(--cyan); color: var(--bg); font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; }
.kb-card h3 { font-family: 'Space Grotesk', sans-serif; font-size: 18px; margin: 0; font-weight: 600; padding-right: 20px; }
.kb-company { color: var(--cyan); font-size: 13px; }
.kb-company-lg { font-size: 15px; margin-bottom: 14px; }
.kb-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.kb-tag { border: 1px solid var(--line); color: var(--muted); font-size: 11px; padding: 4px 8px; border-radius: 3px; font-family: 'IBM Plex Mono', monospace; }
.kb-tag-salary { border-color: var(--amber); color: var(--amber); }
.kb-card-bottom { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; }
.kb-salary { font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: var(--ink); }
.kb-view-link { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--cyan); }

.kb-corner { position: absolute; width: 10px; height: 10px; border-color: var(--line); opacity: 0.8; pointer-events: none; }
.kb-card:hover .kb-corner, .kb-detail-card .kb-corner, .kb-confirm-card .kb-corner, .kb-app-row .kb-corner { border-color: var(--cyan); }
.kb-corner-tl { top: -1px; left: -1px; border-top: 1px solid; border-left: 1px solid; }
.kb-corner-tr { top: -1px; right: -1px; border-top: 1px solid; border-right: 1px solid; }
.kb-corner-bl { bottom: -1px; left: -1px; border-bottom: 1px solid; border-left: 1px solid; }
.kb-corner-br { bottom: -1px; right: -1px; border-bottom: 1px solid; border-right: 1px solid; }

.kb-back { background: none; border: none; color: var(--muted); cursor: pointer; font-family: 'IBM Plex Mono', monospace; font-size: 12px; margin-bottom: 18px; padding: 0; }
.kb-back:hover { color: var(--cyan); }

.kb-detail-card, .kb-confirm-card { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 2px; padding: 32px; margin-bottom: 40px; }
.kb-detail-card h1, .kb-confirm-card h2 { font-family: 'Space Grotesk', sans-serif; font-weight: 700; margin: 6px 0 4px; }
.kb-detail-card h1 { font-size: 28px; }
.kb-divider { border-top: 1px dashed var(--line); margin: 22px 0; }
.kb-section-label { font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.1em; color: var(--cyan); margin: 0 0 8px; }
.kb-body-text { color: var(--ink); line-height: 1.6; font-size: 14px; }
.kb-req-list { list-style: none; padding: 0; margin: 0 0 8px; display: flex; flex-direction: column; gap: 8px; }
.kb-req-list li { display: flex; gap: 10px; font-size: 14px; color: var(--ink); }
.kb-req-index { font-family: 'IBM Plex Mono', monospace; color: var(--amber); font-size: 12px; }

.kb-btn-primary { background: var(--amber); color: var(--bg); border: none; font-weight: 600; font-family: 'Space Grotesk', sans-serif; font-size: 14px; padding: 12px 22px; border-radius: 3px; cursor: pointer; margin-top: 8px; }
.kb-btn-primary:hover { filter: brightness(1.08); }
.kb-btn-full { width: 100%; }
.kb-btn-link { display: block; text-align: center; text-decoration: none; box-sizing: border-box; }
.kb-btn-secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); font-weight: 600; font-family: 'Space Grotesk', sans-serif; font-size: 13px; padding: 10px 16px; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.kb-btn-secondary:hover { border-color: var(--cyan); color: var(--cyan); }
.kb-btn-sm { padding: 7px 12px; font-size: 11px; }
.kb-detail-actions { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.kb-source-note { color: var(--muted); font-size: 11px; font-family: 'IBM Plex Mono', monospace; margin-top: 14px; text-align: center; }
.kb-tracker-note { color: var(--muted); font-size: 13px; font-style: italic; margin: 4px 0 0; }

.kb-spec-form { display: flex; flex-direction: column; gap: 4px; }
.kb-spec-field { display: flex; gap: 14px; padding: 14px 0; border-top: 1px solid var(--line); }
.kb-spec-field:first-child { border-top: none; }
.kb-spec-index { font-family: 'IBM Plex Mono', monospace; color: var(--amber); font-size: 12px; padding-top: 10px; width: 20px; flex-shrink: 0; }
.kb-spec-body { flex: 1; }
.kb-spec-label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.kb-textarea { resize: vertical; font-family: 'IBM Plex Sans', sans-serif; }
.kb-row-2 { display: flex; gap: 10px; }

.kb-confirm-card { text-align: center; padding: 44px 32px; display: flex; flex-direction: column; align-items: center; }
.kb-ref-box { margin: 18px 0; padding: 14px 24px; border: 1px dashed var(--amber); border-radius: 4px; display: inline-flex; flex-direction: column; gap: 4px; align-items: center; }
.kb-ref-code { font-family: 'IBM Plex Mono', monospace; font-size: 20px; color: var(--amber); letter-spacing: 0.05em; }

.kb-apps-title { font-family: 'Space Grotesk', sans-serif; font-size: 30px; margin: 8px 0 24px; }
.kb-apps-list { display: flex; flex-direction: column; gap: 10px; }
.kb-app-row { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 2px; padding: 16px 18px; display: flex; align-items: center; gap: 18px; }
.kb-alert-row { align-items: flex-start; justify-content: space-between; }
.kb-alert-stats { flex-shrink: 0; text-align: right; }
.kb-app-ref { font-family: 'IBM Plex Mono', monospace; color: var(--amber); font-size: 12px; width: 90px; flex-shrink: 0; }
.kb-app-main { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.kb-app-title { background: none; border: none; color: var(--ink); font-family: 'Space Grotesk', sans-serif; font-weight: 600; font-size: 15px; text-align: left; cursor: pointer; padding: 0; }
.kb-app-title:hover { color: var(--cyan); }
.kb-app-status { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--muted); flex-shrink: 0; }

.kb-footer { max-width: 1120px; margin: 0 auto; padding: 20px 20px 40px; display: flex; justify-content: space-between; font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: var(--line); letter-spacing: 0.05em; }

@media (max-width: 640px) {
  .kb-hero h1 { font-size: 30px; }
  .kb-header-inner { flex-direction: column; gap: 10px; align-items: flex-start; }
  .kb-row-2 { flex-direction: column; }
  .kb-app-row { flex-wrap: wrap; }
  .kb-alert-row { flex-direction: column; }
  .kb-alert-stats { text-align: left; }
}
`;

import React, { useState, useEffect } from 'react';

declare global {
  interface Window {
    __API_KEY__?: string;
  }
}

interface Slot {
  id: string;
  provider: string;
  start: string;
  end: string;
  available: boolean;
}

interface Booking {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: string;
  created_at: string;
  provider?: string;
  slotTime?: string;
}

export default function App() {
  const [copied, setCopied] = useState(false);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  // Selected slot for modal
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Confirmed booking card
  const [confirmedBooking, setConfirmedBooking] = useState<Booking | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);

  const getApiKey = () => window.__API_KEY__ || '';

  const copyApiKey = () => {
    const key = getApiKey();
    if (navigator.clipboard && key) {
      navigator.clipboard.writeText(key).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  const fetchSlots = async () => {
    try {
      setPageError(null);
      const res = await fetch('/slots', {
        headers: {
          'X-API-Key': getApiKey(),
        },
      });
      if (!res.ok) {
        throw new Error(`Failed to load slots (${res.status})`);
      }
      const data = await res.json();
      setSlots(data.slots || []);
    } catch (err: any) {
      setPageError(err.message || 'Network error while loading slots');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSlots();
  }, []);

  // Filter available and upcoming slots only
  const now = new Date();
  const availableUpcomingSlots = slots.filter((s) => {
    if (!s.available) return false;
    const start = new Date(s.start);
    return start > now;
  });

  // Group by provider, then day
  const grouped: Record<string, Record<string, Slot[]>> = {};
  for (const s of availableUpcomingSlots) {
    if (!grouped[s.provider]) {
      grouped[s.provider] = {};
    }
    const day = new Date(s.start).toLocaleDateString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    if (!grouped[s.provider][day]) {
      grouped[s.provider][day] = [];
    }
    grouped[s.provider][day].push(s);
  }

  const handleBookClick = (slot: Slot) => {
    setSelectedSlot(slot);
    setFormName('');
    setFormEmail('');
    setFieldErrors({});
    setSubmitError(null);
  };

  const handleBookingSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: { name?: string; email?: string } = {};
    const trimmedName = formName.trim();
    const trimmedEmail = formEmail.trim();

    if (!trimmedName) {
      errors.name = 'Name is required';
    }
    if (!trimmedEmail) {
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      errors.email = 'Invalid email address';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    if (!selectedSlot) return;

    setSubmitting(true);
    setSubmitError(null);

    const idempotencyKey = crypto.randomUUID();

    try {
      const res = await fetch('/bookings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': getApiKey(),
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          slot_id: selectedSlot.id,
          name: trimmedName,
          email: trimmedEmail,
        }),
      });

      if (res.status === 201) {
        const booking = await res.json();
        setConfirmedBooking({
          ...booking,
          provider: selectedSlot.provider,
          slotTime: `${new Date(selectedSlot.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${new Date(selectedSlot.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        });
        setSelectedSlot(null);
        await fetchSlots();
      } else if (res.status === 409) {
        setSubmitError('This slot was just taken by someone else. Please choose another slot.');
        await fetchSlots();
      } else if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After') || '60';
        setSubmitError(`Too many booking attempts. Please wait ${retryAfter} second(s) before trying again.`);
      } else if (res.status === 400) {
        const data = await res.json().catch(() => ({}));
        setSubmitError(data.error || 'Invalid booking details provided.');
      } else {
        setSubmitError('An unexpected error occurred. Please try again.');
      }
    } catch {
      setSubmitError('Network error. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelBooking = async (id: string) => {
    setCancelling(true);
    setCancelMessage(null);
    try {
      const res = await fetch(`/bookings/${id}`, {
        method: 'DELETE',
        headers: {
          'X-API-Key': getApiKey(),
        },
      });

      if (res.ok) {
        setConfirmedBooking((prev) => (prev ? { ...prev, status: 'cancelled' } : null));
        setCancelMessage('Booking cancelled successfully.');
        await fetchSlots();
      } else if (res.status === 409) {
        setCancelMessage('This booking is already cancelled.');
      } else if (res.status === 404) {
        setCancelMessage('Booking not found.');
      } else {
        setCancelMessage('Failed to cancel booking.');
      }
    } catch {
      setCancelMessage('Network error while cancelling booking.');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="container">
      <header>
        <h1>Clinic Booking</h1>
        <p className="subtitle">Book appointments with available healthcare providers.</p>
      </header>

      {/* API Key Box */}
      <div className="key-card">
        <div>
          <label>API Key</label>
          <div className="key-masked">••••••••••••••••••••••••••••••••</div>
        </div>
        <button className="btn-secondary" onClick={copyApiKey}>
          {copied ? 'Copied' : 'Copy API key'}
        </button>
      </div>

      {/* Summary Docs Section */}
      <section className="docs-card">
        <h2 className="docs-title">API & System Summary</h2>
        <p className="docs-intro">
          This system provides an end-to-end clinic scheduling service adhering to OpenAPI 3.0 standards:
        </p>
        <div className="docs-grid">
          <div className="doc-item">
            <strong>1. Authentication</strong>
            <p>All endpoints require the <code>X-API-Key</code> header matching the clinic key above.</p>
          </div>
          <div className="doc-item">
            <strong>2. Reset & Sync</strong>
            <p><code>POST /reset</code> cleanly purges and reseeds slots, bookings, and rate limits atomically.</p>
          </div>
          <div className="doc-item">
            <strong>3. Concurrency Protection</strong>
            <p>Simultaneous booking requests for the same slot return exactly one <code>201</code> and all others <code>409</code>.</p>
          </div>
          <div className="doc-item">
            <strong>4. Idempotency & Rate Limits</strong>
            <p><code>Idempotency-Key</code> header prevents duplicate bookings. Capped at 5 attempts/min per email (returns <code>429</code> with <code>Retry-After</code>).</p>
          </div>
        </div>
      </section>

      {/* Confirmation Card */}
      {confirmedBooking && (
        <div className="confirm-card">
          <h2 className="section-title">Booking Confirmation</h2>
          {cancelMessage && <div className="banner banner-success">{cancelMessage}</div>}
          <div className="confirm-details">
            <p><span>Booking ID:</span> {confirmedBooking.id}</p>
            {confirmedBooking.provider && <p><span>Provider:</span> {confirmedBooking.provider}</p>}
            {confirmedBooking.slotTime && <p><span>Slot Time:</span> {confirmedBooking.slotTime}</p>}
            <p><span>Name:</span> {confirmedBooking.name}</p>
            <p><span>Email:</span> {confirmedBooking.email}</p>
            <p><span>Status:</span> <strong style={{ color: confirmedBooking.status === 'confirmed' ? 'var(--primary)' : 'var(--danger)' }}>{confirmedBooking.status}</strong></p>
          </div>
          {confirmedBooking.status === 'confirmed' && (
            <button
              className="btn-danger"
              disabled={cancelling}
              onClick={() => handleCancelBooking(confirmedBooking.id)}
            >
              {cancelling ? 'Cancelling...' : 'Cancel Booking'}
            </button>
          )}
        </div>
      )}

      {/* Slots Section */}
      <section>
        <h2 className="section-title">Available Appointments</h2>

        {pageError && <div className="banner banner-error">{pageError}</div>}

        {loading ? (
          <p className="subtitle">Loading available slots...</p>
        ) : Object.keys(grouped).length === 0 ? (
          <p className="subtitle">No upcoming available slots found.</p>
        ) : (
          Object.entries(grouped).map(([provider, days]) => (
            <div key={provider} className="provider-group">
              <h3 className="provider-name">{provider}</h3>
              {Object.entries(days).map(([day, daySlots]) => (
                <div key={day} className="day-group">
                  <div className="day-label">{day}</div>
                  <div className="slots-grid">
                    {daySlots.map((slot) => {
                      const startTime = new Date(slot.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                      const endTime = new Date(slot.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                      return (
                        <button
                          key={slot.id}
                          className="slot-btn"
                          onClick={() => handleBookClick(slot)}
                        >
                          {startTime} - {endTime}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </section>

      {/* Booking Modal */}
      {selectedSlot && (
        <div className="booking-modal" onClick={() => setSelectedSlot(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-header">Confirm Appointment</h3>
            <p className="modal-desc">
              With <strong>{selectedSlot.provider}</strong> on{' '}
              {new Date(selectedSlot.start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} at{' '}
              {new Date(selectedSlot.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </p>

            {submitError && <div className="banner banner-error">{submitError}</div>}

            <form onSubmit={handleBookingSubmit}>
              <div className="form-group">
                <label>Full Name</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Jane Doe"
                  disabled={submitting}
                />
                {fieldErrors.name && <div className="form-error">{fieldErrors.name}</div>}
              </div>

              <div className="form-group">
                <label>Email Address</label>
                <input
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder="jane@example.com"
                  disabled={submitting}
                />
                {fieldErrors.email && <div className="form-error">{fieldErrors.email}</div>}
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setSelectedSlot(null)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={submitting}
                >
                  {submitting ? 'Booking...' : 'Book Slot'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

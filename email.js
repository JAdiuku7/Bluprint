// Minimal transactional email sender. Uses Resend
// (https://resend.com) if RESEND_API_KEY is set; otherwise logs the
// email to the console so local dev works without a real provider.
// Swap sendEmail's internals for SendGrid/Postmark/SES if you'd
// rather use one of those — they all follow a similar single-call shape.

const FROM_EMAIL = process.env.FROM_EMAIL || "Bluprint <onboarding@resend.dev>";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

async function sendEmail({ to, subject, html, text }) {
    if (!process.env.RESEND_API_KEY) {
        console.log(`\n[email:dev] Would send "${subject}" to ${to}:\n${text || html}\n`);
        return { devMode: true };
    }

    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: FROM_EMAIL, to, subject, html, text }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Email send failed (${res.status}): ${body}`);
    }

    return res.json();
}

function verificationEmail(email, token) {
    const link = `${FRONTEND_URL}/verify-email?token=${token}`;
    return sendEmail({
        to: email,
        subject: "Verify your Bluprint email",
        text: `Verify your email: ${link}\n\nThis link expires in 24 hours.`,
        html: `<p>Welcome to Bluprint — verify your email to finish setting up your account.</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
    });
}

function passwordResetEmail(email, token) {
    const link = `${FRONTEND_URL}/reset-password?token=${token}`;
    return sendEmail({
        to: email,
        subject: "Reset your Bluprint password",
        text: `Reset your password: ${link}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
        html: `<p>Reset your Bluprint password:</p><p><a href="${link}">Reset password</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`,
    });
}

export { sendEmail, verificationEmail, passwordResetEmail };
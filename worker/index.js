import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

// Each form posts to /api/forms with a hidden form-name field. This maps it to an email subject and a thank-you page.
const FORMS = {
    "baseball-card-request": {
        subject: "New baseball card request",
        redirect: "/projects/baseball-cards-success",
        nameField: "parent_name",
        emailField: "parent_email",
    },
};

const SENDER = { name: "eliaskeyes.com", addr: "forms@eliaskeyes.com" };
const SKIPPED_FIELDS = new Set(["form-name", "bot-field"]);

// Cloudflare caps an email at 25 MB, and base64 encoding adds about a third, so photos over this size are left off.
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.hostname.startsWith("www.")) {
            url.hostname = url.hostname.slice(4);
            return Response.redirect(url.toString(), 301);
        }

        if (url.pathname === "/api/forms" && request.method === "POST") {
            return handleForm(request, env);
        }

        return env.ASSETS.fetch(request);
    },
};

async function handleForm(request, env) {
    const data = await request.formData();
    const form = FORMS[data.get("form-name")];

    if (!form) {
        return new Response("Unknown form.", { status: 400 });
    }

    const thankYou = Response.redirect(new URL(form.redirect, request.url).toString(), 303);

    // The honeypot field is hidden from people, so anything in it came from a bot. Pretend it worked.
    if (data.get("bot-field")) {
        return thankYou;
    }

    const lines = [];
    const files = [];
    for (const [key, value] of data) {
        if (SKIPPED_FIELDS.has(key)) continue;
        if (typeof value === "string") {
            lines.push(`${labelFor(key)}: ${value.trim() || "(blank)"}`);
        } else if (value.size > 0) {
            files.push(value);
        }
    }

    const msg = createMimeMessage();
    msg.setSender(SENDER);
    msg.setRecipient(env.FORMS_TO);
    msg.setSubject(`${form.subject} from ${data.get(form.nameField) || "someone"}`);
    if (data.get(form.emailField)) {
        msg.setHeader("Reply-To", data.get(form.emailField));
    }

    for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
            lines.push(`Photo: ${file.name} was too large to attach (${Math.round(file.size / 1024 / 1024)} MB). Ask them to email it.`);
            continue;
        }
        msg.addAttachment({
            filename: file.name || "photo",
            contentType: file.type || "application/octet-stream",
            data: Buffer.from(await file.arrayBuffer()).toString("base64"),
        });
    }

    msg.addMessage({ contentType: "text/plain", data: lines.join("\n\n") });

    try {
        await env.FORMS_EMAIL.send(new EmailMessage(SENDER.addr, env.FORMS_TO, msg.asRaw()));
    } catch (error) {
        console.error("Form email failed", error);
        return new Response("Sorry, your request didn't go through. Please try again in a few minutes.", { status: 500 });
    }

    return thankYou;
}

function labelFor(key) {
    const words = key.replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
}

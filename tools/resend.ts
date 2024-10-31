import { z } from "zod";
import { Resend } from "resend";
import { ask } from "./ask";

const resend_key = process.env.RESEND_API_KEY?.trim();

if (!resend_key) {
  throw new Error("RESEND_API_KEY is required");
}

const resend = new Resend(resend_key);

export const ResendParams = z.object({
  to: z.string().email(),
  subject: z.string(),
  text: z.string(),
});

export type ResendParams = z.infer<typeof ResendParams>;

export async function send_email({ to, subject, text }: ResendParams) {
  if (to.includes("example.com")) {
    return {
      error:
        "Invalid email, this is just an example email please find the user's real email using search user id tool",
    };
  }

  try {
    await resend.emails.send({
      from: "anya@tri.raj.how",
      to,
      subject,
      replyTo: "anya@raj.how",
      html:
        (await formatToHtml({
          to,
          subject,
          html: text,
        })) ?? text,
    });
    return {
      response: "Email sent",
    };
  } catch (error) {
    return {
      error,
    };
  }
}

const vercel_invite_template = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">

  <head>
    <link rel="preload" as="image" href="https://react-email-demo-hbzssj3q3-resend.vercel.app/static/vercel-logo.png" />
    <link rel="preload" as="image" href="https://react-email-demo-hbzssj3q3-resend.vercel.app/static/vercel-user.png" />
    <link rel="preload" as="image" href="https://react-email-demo-hbzssj3q3-resend.vercel.app/static/vercel-arrow.png" />
    <link rel="preload" as="image" href="https://react-email-demo-hbzssj3q3-resend.vercel.app/static/vercel-team.png" />
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" /><!--$-->
  </head>
  <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">Join Alan on Vercel<div> ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿</div>
  </div>

  <body style="background-color:rgb(255,255,255);margin-top:auto;margin-bottom:auto;margin-left:auto;margin-right:auto;font-family:ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, Roboto, &quot;Helvetica Neue&quot;, Arial, &quot;Noto Sans&quot;, sans-serif, &quot;Apple Color Emoji&quot;, &quot;Segoe UI Emoji&quot;, &quot;Segoe UI Symbol&quot;, &quot;Noto Color Emoji&quot;;padding-left:0.5rem;padding-right:0.5rem">
    <table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="border-width:1px;border-style:solid;border-color:rgb(234,234,234);border-radius:0.25rem;margin-top:40px;margin-bottom:40px;margin-left:auto;margin-right:auto;padding:20px;max-width:465px">
      <tbody>
        <tr style="width:100%">
          <td>
            <table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="margin-top:32px">
              <tbody>
                <tr>
                  <td><img alt="Vercel" height="37" src="https://react-email-demo-hbzssj3q3-resend.vercel.app/static/vercel-logo.png" style="margin-top:0px;margin-bottom:0px;margin-left:auto;margin-right:auto;display:block;outline:none;border:none;text-decoration:none" width="40" /></td>
                </tr>
              </tbody>
            </table>
            <h1 style="color:rgb(0,0,0);font-size:24px;font-weight:400;text-align:center;padding:0px;margin-top:30px;margin-bottom:30px;margin-left:0px;margin-right:0px">Join <strong>Enigma</strong> on <strong>Vercel</strong></h1>
            <p style="color:rgb(0,0,0);font-size:14px;line-height:24px;margin:16px 0">Hello <!-- -->alanturing<!-- -->,</p>
            <p style="color:rgb(0,0,0);font-size:14px;line-height:24px;margin:16px 0"><strong>Alan</strong> (<a href="mailto:alan.turing@example.com" style="color:rgb(37,99,235);text-decoration-line:none;text-decoration:none" target="_blank">alan.turing@example.com</a>) has invited you to the <strong>Enigma</strong> team on<!-- --> <strong>Vercel</strong>.</p>
            <table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation">
              <tbody>
                <tr>
                  <td>
                    <table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation">
                      <tbody style="width:100%">
                        <tr style="width:100%">
                          <td align="right" data-id="__react-email-column"><img height="64" src="https://react-email-demo-hbzssj3q3-resend.vercel.app/static/vercel-user.png" style="border-radius:9999px;display:block;outline:none;border:none;text-decoration:none" width="64" /></td>
                          <td align="center" data-id="__react-email-column"><img alt="invited you to" height="9" src="https://react-email-demo-hbzssj3q3-resend.vercel.app/static/vercel-arrow.png" style="display:block;outline:none;border:none;text-decoration:none" width="12" /></td>
                          <td align="left" data-id="__react-email-column"><img height="64" src="https://react-email-demo-hbzssj3q3-resend.vercel.app/static/vercel-team.png" style="border-radius:9999px;display:block;outline:none;border:none;text-decoration:none" width="64" /></td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>
            <table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="text-align:center;margin-top:32px;margin-bottom:32px">
              <tbody>
                <tr>
                  <td><a href="https://vercel.com/teams/invite/foo" style="background-color:rgb(0,0,0);border-radius:0.25rem;color:rgb(255,255,255);font-size:12px;font-weight:600;text-decoration-line:none;text-align:center;padding-left:1.25rem;padding-right:1.25rem;padding-top:0.75rem;padding-bottom:0.75rem;line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;padding:12px 20px 12px 20px" target="_blank"><span><!--[if mso]><i style="mso-font-width:500%;mso-text-raise:18" hidden>&#8202;&#8202;</i><![endif]--></span><span style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px">Join the team</span><span><!--[if mso]><i style="mso-font-width:500%" hidden>&#8202;&#8202;&#8203;</i><![endif]--></span></a></td>
                </tr>
              </tbody>
            </table>
            <p style="color:rgb(0,0,0);font-size:14px;line-height:24px;margin:16px 0">or copy and paste this URL into your browser:<!-- --> <a href="https://vercel.com/teams/invite/foo" style="color:rgb(37,99,235);text-decoration-line:none;text-decoration:none" target="_blank">https://vercel.com/teams/invite/foo</a></p>
            <hr style="border-width:1px;border-style:solid;border-color:rgb(234,234,234);margin-top:26px;margin-bottom:26px;margin-left:0px;margin-right:0px;width:100%;border:none;border-top:1px solid #eaeaea" />
            <p style="color:rgb(102,102,102);font-size:12px;line-height:24px;margin:16px 0">This invitation was intended for<!-- --> <span style="color:rgb(0,0,0)">alanturing</span>. This invite was sent from <span style="color:rgb(0,0,0)">204.13.186.218</span> <!-- -->located in<!-- --> <span style="color:rgb(0,0,0)">São Paulo, Brazil</span>. If you were not expecting this invitation, you can ignore this email. If you are concerned about your account&#x27;s safety, please reply to this email to get in touch with us.</p>
          </td>
        </tr>
      </tbody>
    </table><!--/$-->
  </body>

</html>`;

const stripe_welcome_template = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">

  <head>
    <link rel="preload" as="image" href="https://react-email-demo-hbzssj3q3-resend.vercel.app/static/stripe-logo.png" />
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" /><!--$-->
  </head>
  <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">You&#x27;re now ready to make live transactions with Stripe!<div> ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿</div>
  </div>

  <body style="background-color:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,&quot;Helvetica Neue&quot;,Ubuntu,sans-serif">
    <table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="max-width:37.5em;background-color:#ffffff;margin:0 auto;padding:20px 0 48px;margin-bottom:64px">
      <tbody>
        <tr style="width:100%">
          <td>
            <table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="padding:0 48px">
              <tbody>
                <tr>
                  <td><img alt="Stripe" height="21" src="https://react-email-demo-hbzssj3q3-resend.vercel.app/static/stripe-logo.png" style="display:block;outline:none;border:none;text-decoration:none" width="49" />
                    <hr style="width:100%;border:none;border-top:1px solid #eaeaea;border-color:#e6ebf1;margin:20px 0" />
                    <p style="font-size:16px;line-height:24px;margin:16px 0;color:#525f7f;text-align:left">Thanks for submitting your account information. You&#x27;re now ready to make live transactions with Stripe!</p>
                    <p style="font-size:16px;line-height:24px;margin:16px 0;color:#525f7f;text-align:left">You can view your payments and a variety of other information about your account right from your dashboard.</p><a href="https://dashboard.stripe.com/login" style="line-height:100%;text-decoration:none;display:block;max-width:100%;mso-padding-alt:0px;background-color:#656ee8;border-radius:5px;color:#fff;font-size:16px;font-weight:bold;text-align:center;width:100%;padding:10px 10px 10px 10px" target="_blank"><span><!--[if mso]><i style="mso-font-width:500%;mso-text-raise:15" hidden>&#8202;</i><![endif]--></span><span style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:7.5px">View your Stripe Dashboard</span><span><!--[if mso]><i style="mso-font-width:500%" hidden>&#8202;&#8203;</i><![endif]--></span></a>
                    <hr style="width:100%;border:none;border-top:1px solid #eaeaea;border-color:#e6ebf1;margin:20px 0" />
                    <p style="font-size:16px;line-height:24px;margin:16px 0;color:#525f7f;text-align:left">If you haven&#x27;t finished your integration, you might find our<!-- --> <a href="https://stripe.com/docs" style="color:#556cd6;text-decoration:none" target="_blank">docs</a> <!-- -->handy.</p>
                    <p style="font-size:16px;line-height:24px;margin:16px 0;color:#525f7f;text-align:left">Once you&#x27;re ready to start accepting payments, you&#x27;ll just need to use your live<!-- --> <a href="https://dashboard.stripe.com/login?redirect=%2Fapikeys" style="color:#556cd6;text-decoration:none" target="_blank">API keys</a> <!-- -->instead of your test API keys. Your account can simultaneously be used for both test and live requests, so you can continue testing while accepting live payments. Check out our<!-- --> <a href="https://stripe.com/docs/dashboard" style="color:#556cd6;text-decoration:none" target="_blank">tutorial about account basics</a>.</p>
                    <p style="font-size:16px;line-height:24px;margin:16px 0;color:#525f7f;text-align:left">Finally, we&#x27;ve put together a<!-- --> <a href="https://stripe.com/docs/checklist/website" style="color:#556cd6;text-decoration:none" target="_blank">quick checklist</a> <!-- -->to ensure your website conforms to card network standards.</p>
                    <p style="font-size:16px;line-height:24px;margin:16px 0;color:#525f7f;text-align:left">We&#x27;ll be here to help you with any step along the way. You can find answers to most questions and get in touch with us on our<!-- --> <a href="https://support.stripe.com/" style="color:#556cd6;text-decoration:none" target="_blank">support site</a>.</p>
                    <p style="font-size:16px;line-height:24px;margin:16px 0;color:#525f7f;text-align:left">— The Stripe team</p>
                    <hr style="width:100%;border:none;border-top:1px solid #eaeaea;border-color:#e6ebf1;margin:20px 0" />
                    <p style="font-size:12px;line-height:16px;margin:16px 0;color:#8898aa">Stripe, 354 Oyster Point Blvd, South San Francisco, CA 94080</p>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table><!--/$-->
  </body>

</html>`;

const linear_login_code_template = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">

  <head>
    <link rel="preload" as="image" href="https://react-email-demo-hbzssj3q3-resend.vercel.app/static/linear-logo.png" />
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" /><!--$-->
  </head>
  <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">Your login code for Linear<div> ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿</div>
  </div>

  <body style="background-color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Oxygen-Sans,Ubuntu,Cantarell,&quot;Helvetica Neue&quot;,sans-serif">
    <table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="max-width:560px;margin:0 auto;padding:20px 0 48px">
      <tbody>
        <tr style="width:100%">
          <td><img alt="Linear" height="42" src="https://react-email-demo-hbzssj3q3-resend.vercel.app/static/linear-logo.png" style="display:block;outline:none;border:none;text-decoration:none;border-radius:21px;width:42px;height:42px" width="42" />
            <h1 style="font-size:24px;letter-spacing:-0.5px;line-height:1.3;font-weight:400;color:#484848;padding:17px 0 0">Your login code for Linear</h1>
            <table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="padding:27px 0 27px">
              <tbody>
                <tr>
                  <td><a href="https://linear.app" style="line-height:100%;text-decoration:none;display:block;max-width:100%;mso-padding-alt:0px;background-color:#5e6ad2;border-radius:3px;font-weight:600;color:#fff;font-size:15px;text-align:center;padding:11px 23px 11px 23px" target="_blank"><span><!--[if mso]><i style="mso-font-width:383.33333333333337%;mso-text-raise:16.5" hidden>&#8202;&#8202;&#8202;</i><![endif]--></span><span style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:8.25px">Login to Linear</span><span><!--[if mso]><i style="mso-font-width:383.33333333333337%" hidden>&#8202;&#8202;&#8202;&#8203;</i><![endif]--></span></a></td>
                </tr>
              </tbody>
            </table>
            <p style="font-size:15px;line-height:1.4;margin:0 0 15px;color:#3c4149">This link and code will only be valid for the next 5 minutes. If the link does not work, you can use the login verification code directly:</p><code style="font-family:monospace;font-weight:700;padding:1px 4px;background-color:#dfe1e4;letter-spacing:-0.3px;font-size:21px;border-radius:4px;color:#3c4149">tt226-5398x</code>
            <hr style="width:100%;border:none;border-top:1px solid #eaeaea;border-color:#dfe1e4;margin:42px 0 26px" /><a href="https://linear.app" style="color:#b4becc;text-decoration:none;font-size:14px" target="_blank">Linear</a>
          </td>
        </tr>
      </tbody>
    </table><!--/$-->
  </body>

</html>`;

const default_message_template = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html dir="ltr" lang="en"><head><meta content="width=device-width" name="viewport"/><link rel="preload" as="image" href="https://maily.to/brand/logo.png"/><meta content="text/html; charset=UTF-8" http-equiv="Content-Type"/><meta name="x-apple-disable-message-reformatting"/><meta content="IE=edge" http-equiv="X-UA-Compatible"/><meta name="x-apple-disable-message-reformatting"/><meta content="telephone=no,address=no,email=no,date=no,url=no" name="format-detection"/><meta content="light" name="color-scheme"/><meta content="light" name="supported-color-schemes"/><!--$--><style>
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 400;
      mso-font-alt: 'sans-serif';
      src: url(https://rsms.me/inter/font-files/Inter-Regular.woff2?v=3.19) format('woff2');
    }

    * {
      font-family: 'Inter', sans-serif;
    }
  </style><style>blockquote,h1,h2,h3,img,li,ol,p,ul{margin-top:0;margin-bottom:0}</style></head><body style="margin:0"><div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0" id="__react-email-preview">hey<div> ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿</div></div><table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="max-width:600px;min-width:300px;width:100%;margin-left:auto;margin-right:auto;padding:0.5rem"><tbody><tr style="width:100%"><td><table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="margin-top:0px;margin-bottom:0px"><tbody style="width:100%"><tr style="width:100%"><td align="left" data-id="__react-email-column"><img title="Logo" alt="Logo" src="https://maily.to/brand/logo.png" style="display:block;outline:none;border:none;text-decoration:none;width:48px;height:48px"/></td></tr></tbody></table><table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="max-width:37.5em;height:64px"><tbody><tr style="width:100%"><td></td></tr></tbody></table><h2 style="text-align:left;color:#111827;margin-bottom:12px;margin-top:0;font-size:30px;line-height:36px;font-weight:700"><strong>Discover Maily</strong></h2><p style="font-size:15px;line-height:24px;margin:16px 0;text-align:left;margin-bottom:20px;margin-top:0px;color:#374151;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale">Are you ready to transform your email communication? Introducing Maily, the powerful email editor that enables you to craft captivating emails effortlessly.</p><p style="font-size:15px;line-height:24px;margin:16px 0;text-align:left;margin-bottom:20px;margin-top:0px;color:#374151;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale">Elevate your email communication with Maily! Click below to try it out:</p><table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="max-width:100%;text-align:left;margin-bottom:0px"><tbody><tr style="width:100%"><td><a href="" style="line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;color:#ffffff;background-color:#141313;border-color:#141313;padding:12px 34px 12px 34px;border-width:2px;border-style:solid;font-size:14px;font-weight:500;border-radius:9999px" target="_blank"><span><!--[if mso]><i style="mso-font-width:425%;mso-text-raise:18" hidden>&#8202;&#8202;&#8202;&#8202;</i><![endif]--></span><span style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px">Try Maily Now →</span><span><!--[if mso]><i style="mso-font-width:425%" hidden>&#8202;&#8202;&#8202;&#8202;&#8203;</i><![endif]--></span></a></td></tr></tbody></table><table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0" role="presentation" style="max-width:37.5em;height:64px"><tbody><tr style="width:100%"><td></td></tr></tbody></table><p style="font-size:15px;line-height:24px;margin:16px 0;text-align:left;margin-bottom:20px;margin-top:0px;color:#374151;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale">Join our vibrant community of users and developers on GitHub, where Maily is an <em><a href="https://github.com/arikchakma/maily.to" rel="noopener noreferrer nofollow" style="color:#111827;text-decoration:underline;font-weight:500" target="_blank">open-source</a></em> project. Together, we&#x27;ll shape the future of email editing.</p><p style="font-size:15px;line-height:24px;margin:16px 0;text-align:left;margin-bottom:20px;margin-top:0px;color:#374151;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale">Regards,<br/>Arikko</p></td></tr></tbody></table><!--/$--></body></html>`;

// use ask function to take some data and pick a relavent template and put the data in it and return the final html string
async function formatToHtml({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) {
  const response = await ask({
    model: "gpt-4o-mini",
    prompt: `Given some subject and html content

    To: ${to}
    Subject: ${subject}
    HTML: ${html}

    Default Template:
    ---
    ${default_message_template}
    ---

    Other Templates to Pick from:
    1. Vercel Invite Template:
    ---
    ${vercel_invite_template}
    ---
    
    2. Stripe Welcome Template (use this for most simple messages):
    ---
    ${stripe_welcome_template}
    ---

    3. Linear Login Code Template:
    ---
    ${linear_login_code_template}
    ---

    Pick a template and put the data in it to create the final HTML string.
    Do not Make up false data, use only the given data.
    Make sure to replace all the example data in the template with data relavent to the context.
    
    RETURN ONLY HTML STRING
    `,
  });
  return response.choices[0].message.content
    ? extractHtmlString(response.choices[0].message.content)
    : null;
}

function extractHtmlString(response: string): string {
  // Use a regular expression to match the HTML string within the response
  const htmlMatch = response.match(/<html[^>]*>([\s\S]*?)<\/html>/i);

  // Return the matched HTML content or an empty string if no match is found
  return htmlMatch ? htmlMatch[0] : "";
}

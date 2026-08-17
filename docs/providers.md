# Provider Verification Matrix

Updated 2026-08-17. "Contract tested" means the request URL, authentication, payload shape, token/signature path, and documented logical-error response are covered by `tests/providers-expanded.test.ts`. It does not mean a real message was delivered: use the channel's **Test** action with that provider's credentials for an online delivery check.

## Newly added native and gateway providers

| Provider | Official contract checked | Endpoint / authentication | Local status |
| --- | --- | --- | --- |
| WhatsApp Business | [Meta text messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages/) | Graph `/v{version}/{phone-number-id}/messages`, Bearer token | Contract tested |
| Signal REST | [signal-cli-rest-api examples](https://github.com/bbernhard/signal-cli-rest-api/blob/master/doc/EXAMPLES.md) | Self-hosted `/v2/send`, JSON body | Contract tested |
| Enterprise WeChat app | [Send app message](https://developer.work.weixin.qq.com/document/path/90236), [access token](https://developer.work.weixin.qq.com/document/path/91039) | `gettoken` then `/cgi-bin/message/send`, `access_token` | Contract tested |
| QQ official bot | [Access token](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html), [message overview](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html) | `getAppAccessToken` then channel/group/user message endpoint, `QQBot` token | Contract tested |
| KOOK | [Message API](https://developer.kookapp.cn/doc/http/message), [HTTP auth](https://developer.kookapp.cn/doc/reference) | `/api/v3/message/create` or direct-message, `Bot` token | Contract tested |
| Firebase Cloud Messaging | [HTTP v1 send](https://firebase.google.com/docs/cloud-messaging/send/v1-api) | Service-account JWT to Google OAuth, then `/v1/projects/*/messages:send` | Contract tested |
| Expo Push | [Expo Push Service](https://docs.expo.dev/push-notifications/sending-notifications/) | `https://exp.host/--/api/v2/push/send`, optional enhanced token | Contract tested |
| OneSignal | [Create message](https://documentation.onesignal.com/reference/create-message) | `/notifications`, `Authorization: Key` | Contract tested |
| SendGrid | [Mail Send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send) | `/v3/mail/send`, Bearer API key | Contract tested |
| Resend | [Send email](https://resend.com/docs/api-reference/emails/send-email) | `/emails`, Bearer API key | Contract tested |
| Postmark | [Email API](https://postmarkapp.com/developer/api/email-api) | `/email`, `X-Postmark-Server-Token` | Contract tested |
| Mailgun | [Send an email](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages) | `/v3/{domain}/messages`, Basic `api:key`, multipart form | Contract tested |
| Brevo | [Send transactional email](https://developers.brevo.com/reference/send-transac-email) | `/v3/smtp/email`, `api-key` | Contract tested |
| Alibaba Cloud SMS | [SendSms](https://help.aliyun.com/en/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms), [RPC signature](https://www.alibabacloud.com/help/en/sdk/product-overview/rpc-mechanism) | `dysmsapi.aliyuncs.com`, RPC HMAC-SHA1 | Contract tested |
| Tencent Cloud SMS | [SendSms](https://cloud.tencent.com/document/api/382/55981), [TC3 request structure](https://cloud.tencent.com/document/api/382/52070) | `sms.tencentcloudapi.com`, TC3-HMAC-SHA256 | Contract tested |
| Home Assistant | [REST API](https://developers.home-assistant.io/docs/api/rest) | `/api/services/notify/{service}`, Bearer long-lived token | Contract tested |
| Nextcloud Talk | [Chat API](https://nextcloud-talk.readthedocs.io/en/latest/chat/) | `/ocs/v2.php/apps/spreed/api/v1/chat/{token}`, Basic app password + OCS header | Contract tested |
| Prometheus Alertmanager | [Alerts API](https://prometheus.io/docs/alerting/latest/alerts_api/) | `/api/v2/alerts`, optional Bearer token | Contract tested |
| Jira Service Management | [Create customer request](https://developer.atlassian.com/cloud/jira/service-desk/rest/api-group-request/) | `/rest/servicedeskapi/request`, Atlassian email + API token Basic auth | Contract tested |

## Existing catalog

The original providers remain in `src/server/providers/catalog.ts`; each entry’s `docsUrl` points to its provider documentation and the existing provider tests continue to run. Apprise remains the long-tail compatibility layer for services that do not have a stable direct API, while generic Webhook remains the escape hatch for private or vendor-specific systems.

## Deliberately not native

Direct APNs requires an HTTP/2 transport and direct Web Push requires VAPID payload encryption. The shared dispatcher runs in Node, Vercel and Cloudflare Workers, so these are not represented as a false “native” checkbox. Use Expo, OneSignal, FCM, or Apprise until a runtime-specific transport and mature encryption library are available in every supported deployment target.

# Provider Verification Matrix

Updated 2026-08-17. "Contract tested" means the request URL, authentication, payload shape, token/signature path, and documented logical-error response are covered by `tests/providers-expanded.test.ts`. It does not mean a real message was delivered: use the channel's **Test** action with that provider's credentials for an online delivery check.

## Newly added native and gateway providers

| Provider | Official contract checked | Endpoint / authentication | Local status |
| --- | --- | --- | --- |
| Join | [Join API](https://joaoapps.com/join/api/) | `joinjoaomgcd.appspot.com/_ah/api/messaging/v1/sendPush`, API key and device IDs | Contract tested |
| IFTTT Webhooks | [Webhooks FAQ](https://help.ifttt.com/hc/en-us/articles/115010230347-Webhooks-service-FAQ) | `maker.ifttt.com/trigger/{event}/with/key/{key}`, JSON `value1`-`value3` | Contract tested |
| Novu | [Trigger event](https://docs.novu.co/api-reference/events/trigger-event) | `/v1/events/trigger`, `Authorization: ApiKey`, workflow and subscriber IDs | Contract tested |
| Knock | [Trigger workflow](https://docs.knock.app/api-reference/workflows/trigger) | `/v1/workflows/{key}/trigger`, Bearer API key, recipient IDs | Contract tested |
| Courier | [Send a message](https://www.courier.com/docs/api-reference/send/send-a-message) | `/send`, Bearer API key, template and typed recipient | Contract tested |
| HONOR Push | [Downlink Message Sending](https://developer.honor.com/doc/guides/101087) | HONOR OAuth client credentials, then `/api/v1/{appId}/sendMessage`, Bearer token | Contract tested |
| OPPO Push | [Server API v1.9.3](https://storepic.oppomobile.com/openplat/resource/201910/18/OPPO%E6%8E%A8%E9%80%81%E5%B9%B3%E5%8F%B0%E6%9C%8D%E5%8A%A1%E7%AB%AFAPI-V1.9.3.pdf) | SHA-256 auth token, then `/server/v1/message/notification/unicast_batch` | Contract tested |
| vivo Push | [Server API](https://dev.vivo.com.cn/documentCenter/doc/362) | MD5-signed `/message/auth`, then `/message/send` with `authToken` | Contract tested |
| Meizu Push | [Official HTTP API](https://github.com/MEIZUPUSH/PushAPI) | Sorted-form MD5 signature, Push ID or alias notification endpoint | Contract tested |
| Pushy | [Send Notifications](https://pushy.me/docs/api/send-notifications) | `/push?api_key=...`, JSON device token / topic payload | Contract tested |
| Pushsafer | [Message API](https://www.pushsafer.com/en/pushapi) | `https://www.pushsafer.com/api`, form-encoded private key and message | Contract tested |
| Simplepush | [Message API](https://simplepush.io/api) | `https://simplepu.sh`, JSON key/title/message | Contract tested |
| Huawei Push Kit | [Send API](https://developer.huawei.com/consumer/en/doc/HMSCore-References/https-send-api-0000001050986197) | OAuth client credentials at `oauth-login.cloud.huawei.com`, then `/v1/{appId}/messages:send`, Bearer token | Contract tested |
| Xiaomi Push | [Server API](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1559) | `/v3/message/{regid\|alias\|topic\|all}`, `Authorization: key=<APP_SECRET>` | Contract tested |
| JPush | [Push API v3](https://docs.jiguang.cn/en/jpush/server/push/rest_api_v3_push/) | `/v3/push`, Basic `appKey:masterSecret` | Contract tested |
| Getui | [Auth](https://docs.getui.com/getui/server/rest_v2/token/), [Push](https://docs.getui.com/getui/server/rest_v2/push/) | `/v2/{appId}/auth` SHA-256 token, then `/push/single/{cid\|alias}` or `/push/all` | Contract tested |
| Amazon SNS | [Publish](https://docs.aws.amazon.com/sns/latest/api/API_Publish.html) | Query `Publish` over HTTPS, AWS SigV4; Topic ARN, Target ARN, or E.164 SMS | Contract tested |
| Pusher Beams | [Publish API](https://pusher.com/docs/beams/reference/publish-api/) | `/publishes/interests` or `/publishes/users`, Bearer secret key | Contract tested |
| Pushpad | [REST API](https://pushpad.xyz/docs/rest_api) | `/api/v1/projects/{projectId}/notifications`, Bearer access token | Contract tested |
| Vonage SMS | [SMS API](https://developer.vonage.com/en/api/sms) | `https://rest.nexmo.com/sms/json`, Basic API key/secret | Contract tested |
| Plivo SMS | [Messages API](https://docs.plivo.com/docs/messaging/api/messages) | `/v1/Account/{authId}/Message/`, Basic Auth, JSON | Contract tested |
| Telnyx SMS | [Send message](https://developers.telnyx.com/docs/messaging/messages/send-message) | `/v2/messages`, Bearer API key | Contract tested |
| Bird SMS | [Send an SMS](https://docs.bird.com/api/quickstarts/send-an-sms-message) | `/workspaces/{workspaceId}/channels/{channelId}/messages`, `AccessKey` | Contract tested |
| Infobip SMS | [Send SMS messages](https://www.infobip.com/docs/api/channels/sms/outbound-sms/send-message/send-sms-messages) | `{baseUrl}/sms/3/messages`, `Authorization: App <API_KEY>` | Contract tested |
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

The newly added local artwork is downloaded from the brand assets used by each provider: IFTTT and Novu from Simple Icons, Knock from `knock.app`, Courier from `courier.com`, and Join from `joinjoaomgcd.appspot.com`. The image-asset test requires one local asset for every catalog entry.

## Deliberately not native

Direct APNs requires an HTTP/2 transport, which the shared dispatcher (Node, Vercel, Cloudflare Workers) cannot provide everywhere, so it is not represented as a false "native" checkbox. Use Huawei/JPush/Getui/FCM/Expo/OneSignal/Pusher Beams/Pushpad (or Apprise) for that platform until a runtime-specific transport is available in every supported deployment target.

Web Push **is** native as of the `webpush` provider: VAPID ES256 signing (RFC 8292) and aes128gcm payload encryption (RFC 8291) are implemented on `globalThis.crypto.subtle`, which exists in all three runtimes, with no third-party library. Subscribe the current browser from **System → Web Push** in the console; payloads over ~3.9 KB are truncated because push services reject bodies above 4 KB.

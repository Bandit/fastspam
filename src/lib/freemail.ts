/**
 * Free webmail domains. Having emailed someone at gmail.com says nothing about
 * a stranger at gmail.com, so for these domains the model is never told the
 * domain is "known". (A specific address you've written to still counts:
 * that's the correspondent index, which matches whole addresses.)
 *
 * Not exhaustive: the common international providers, plus country variants
 * of the big ones.
 */
const EXACT = new Set([
  "gmail.com",
  "googlemail.com",
  "msn.com",
  "passport.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "pm.me",
  "protonmail.com",
  "protonmail.ch",
  "tutanota.com",
  "tutanota.de",
  "tutamail.com",
  "tuta.io",
  "tuta.com",
  "zoho.com",
  "zohomail.com",
  "mail.com",
  "email.com",
  "web.de",
  "freenet.de",
  "t-online.de",
  "orange.fr",
  "laposte.net",
  "free.fr",
  "libero.it",
  "virgilio.it",
  "seznam.cz",
  "wp.pl",
  "o2.pl",
  "interia.pl",
  "mail.ru",
  "bk.ru",
  "inbox.ru",
  "list.ru",
  "rambler.ru",
  "qq.com",
  "163.com",
  "126.com",
  "yeah.net",
  "sina.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "rediffmail.com",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "duck.com",
  "hushmail.com",
  "mailfence.com",
  "posteo.de",
  "posteo.net",
  "mailbox.org",
  "runbox.com",
  "aim.com",
]);

/** Providers with a domain per country: hotmail.co.uk, yahoo.com.au, gmx.de, yandex.ru, … */
const FAMILIES = /^(hotmail|outlook|live|windowslive|yahoo|ymail|rocketmail|aol|gmx|yandex|ya)\.(com|net|[a-z]{2})(\.[a-z]{2})?$/;

export function isFreemail(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  return EXACT.has(d) || FAMILIES.test(d);
}

/** application 使用的窄 canonical digest 端口，由组合根注入权威 JCS 实现。 */
export interface CanonicalDigestPort {
  digest: (value: unknown) => string;
}

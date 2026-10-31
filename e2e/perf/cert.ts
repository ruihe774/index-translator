// A throwaway self-signed certificate for the HTTP/2 proxy (browsers speak HTTP/2 only over TLS). The browser is
// started with `--ignore-certificate-errors`.

export interface Cert {
  key: string;
  cert: string;
}

export async function selfSignedCert(dir: string, host: string): Promise<Cert> {
  const key = `${dir}/key.pem`;
  const cert = `${dir}/cert.pem`;
  const made =
    await Bun.$`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj /CN=${host} -addext subjectAltName=DNS:${host} -keyout ${key} -out ${cert}`
      .quiet()
      .nothrow();
  if (made.exitCode !== 0) {
    throw new Error(`openssl could not make a certificate: ${made.stderr.toString()}`);
  }
  return { key: await Bun.file(key).text(), cert: await Bun.file(cert).text() };
}

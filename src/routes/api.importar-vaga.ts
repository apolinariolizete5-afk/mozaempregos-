import { createFileRoute } from "@tanstack/react-router";

type ImportedJob = {
  titulo: string;
  empresa: string;
  provincia: string;
  tipo_contrato: string;
  salario: string;
  prazo: string;
  descricao: string;
  requisitos: string;
  como_candidatar: string;
  email_candidatura: string;
  imagem_url: string;
};

const emptyJob = (): ImportedJob => ({
  titulo: "",
  empresa: "",
  provincia: "",
  tipo_contrato: "",
  salario: "",
  prazo: "",
  descricao: "",
  requisitos: "",
  como_candidatar: "",
  email_candidatura: "",
  imagem_url: "",
});

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return decodeEntities(value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function meta(html: string, key: string): string {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1];
    const value = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (name?.toLowerCase() === key.toLowerCase() && value) return plainText(value);
  }
  return "";
}

function findJobPosting(html: string): Record<string, unknown> | null {
  const scripts = html.match(/<script\b[^>]*type=[\"']application\/ld\+json[\"'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
  for (const script of scripts) {
    const raw = script.replace(/^.*?>/s, "").replace(/<\/script>$/i, "").trim();
    try {
      const parsed: unknown = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const obj = candidate as Record<string, unknown>;
        if (obj["@type"] === "JobPosting") return obj;
        const graph = obj["@graph"];
        if (Array.isArray(graph)) {
          const job = graph.find((item) => item && typeof item === "object" && (item as Record<string, unknown>)["@type"] === "JobPosting");
          if (job) return job as Record<string, unknown>;
        }
      }
    } catch {
      // Ignorar JSON-LD inválido e tentar os metadados normais da página.
    }
  }
  return null;
}

function safePublicUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("Cole um link válido da vaga.");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("O link não é válido. Inclua https:// ou http://."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Só são aceites links HTTP ou HTTPS.");
  if (url.username || url.password) throw new Error("Este link não é aceite.");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    host === "127.0.0.1" || host === "::1" || host === "0.0.0.0" ||
    /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)
  ) throw new Error("Este endereço não pode ser importado.");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("O link usa uma porta não permitida.");
  url.hash = "";
  return url;
}

function dateValue(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function jobFromPage(html: string, pageUrl: URL): ImportedJob {
  const job = findJobPosting(html);
  const result = emptyJob();
  const title = plainText(job?.title) || meta(html, "og:title") || meta(html, "twitter:title") ||
    plainText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  result.titulo = title;
  const org = job?.hiringOrganization;
  if (org && typeof org === "object") {
    result.empresa = plainText((org as Record<string, unknown>).name);
    const logo = (org as Record<string, unknown>).logo;
    if (typeof logo === "string") result.imagem_url = logo;
    else if (logo && typeof logo === "object") result.imagem_url = plainText((logo as Record<string, unknown>).url);
  }
  result.empresa ||= meta(html, "og:site_name");
  result.descricao = plainText(job?.description) || meta(html, "og:description") || meta(html, "description");
  const requirements = job?.qualifications ?? job?.skills ?? job?.experienceRequirements;
  result.requisitos = plainText(requirements);
  const salary = job?.baseSalary;
  if (salary && typeof salary === "object") {
    const s = salary as Record<string, unknown>;
    const value = s.value && typeof s.value === "object" ? (s.value as Record<string, unknown>) : {};
    result.salario = [value.minValue, value.maxValue].filter((v) => v != null).join(" - ") ||
      (value.value != null ? String(value.value) : "");
    if (typeof s.currency === "string") result.salario = (result.salario + " " + s.currency).trim();
  }
  result.prazo = dateValue(job?.validThrough);
  const employment = job?.employmentType;
  result.tipo_contrato = Array.isArray(employment) ? employment.join(", ") : typeof employment === "string" ? employment : "";
  const location = job?.jobLocation;
  if (location && typeof location === "object") {
    const loc = Array.isArray(location) ? location[0] : location;
    if (loc && typeof loc === "object") {
      const address = (loc as Record<string, unknown>).address;
      if (address && typeof address === "object") {
        const a = address as Record<string, unknown>;
        result.provincia = plainText(a.addressRegion) || plainText(a.addressLocality);
      }
    }
  }
  const apply = job?.url;
  if (typeof apply === "string" && apply.startsWith("https://")) result.como_candidatar = "Consulte as instruções de candidatura indicadas no anúncio original.";
  result.imagem_url ||= meta(html, "og:image");
  // Nunca guardar a URL de origem no registo da vaga.
  void pageUrl;
  return result;
}

export const Route = createFileRoute("/api/importar-vaga")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json() as { url?: unknown };
          const url = safePublicUrl(body.url);
          const response = await fetch(url, {
            headers: {
              "User-Agent": "MZEmpregosJobImporter/1.0 (+public job listing import)",
              Accept: "text/html,application/xhtml+xml",
            },
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) return Response.json({ error: "O site de origem respondeu com erro (" + response.status + ")." }, { status: 422 });
          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
            return Response.json({ error: "O link não parece ser uma página HTML de uma vaga." }, { status: 422 });
          }
          const declaredSize = Number(response.headers.get("content-length") ?? 0);
          if (declaredSize > 1_500_000) return Response.json({ error: "A página é demasiado grande para importar." }, { status: 413 });
          const html = (await response.text()).slice(0, 1_500_000);
          const vaga = jobFromPage(html, url);
          if (!vaga.titulo && !vaga.descricao) {
            return Response.json({ error: "Não consegui extrair os dados desta página. O site pode bloquear a importação; preencha os campos manualmente." }, { status: 422 });
          }
          return Response.json({ vaga });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const safeMessage = message.includes("fetch") || message.includes("timeout") || message.includes("aborted")
            ? "Não foi possível ler este site. Pode bloquear importações automáticas."
            : message || "Falha ao importar a vaga.";
          return Response.json({ error: safeMessage }, { status: 400 });
        }
      },
    },
  },
});

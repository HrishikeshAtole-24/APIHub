/**
 * Integration code generation (report Feature 7, "API Test Generator").
 *
 * One generator per target language, selected by a factory (report 22:
 * Strategy + Factory). Adding a language is adding a generator, not editing a
 * switch buried in a route handler.
 *
 * Security note: secrets are NEVER inlined. Wherever a credential would go,
 * the generated code reads an environment variable instead, so a snippet
 * pasted into a public repository or a screenshot cannot leak a key.
 */
import { CODE_LANGUAGE_SYNTAX, type CodeGenResult, type CodeLanguage, type PlaygroundRequest } from '@apihub/contracts';

/** Normalised view of a request, shared by every generator. */
interface CodeContext {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
  contentType: string | null;
  /** Environment variable name holding the credential, if any. */
  secretEnv: string | null;
  /** How the credential is applied. */
  secretPlacement: 'header' | 'query' | 'basic' | null;
  secretHeaderName: string | null;
  secretQueryName: string | null;
}

const SECRET_ENV = 'API_KEY';

function buildContext(request: PlaygroundRequest): CodeContext {
  const url = new URL(request.url);
  for (const param of request.queryParams) {
    if (param.enabled && param.name.trim()) url.searchParams.set(param.name, param.value);
  }

  const headers: [string, string][] = request.headers
    .filter((header) => header.enabled && header.name.trim())
    .map((header) => [header.name, header.value]);

  if (request.contentType && request.body) {
    headers.push(['Content-Type', request.contentType]);
  }

  const context: CodeContext = {
    method: request.method,
    url: url.toString(),
    headers,
    body: request.body ?? null,
    contentType: request.contentType ?? null,
    secretEnv: null,
    secretPlacement: null,
    secretHeaderName: null,
    secretQueryName: null,
  };

  switch (request.auth.type) {
    case 'bearer':
      context.secretEnv = SECRET_ENV;
      context.secretPlacement = 'header';
      context.secretHeaderName = 'Authorization';
      break;
    case 'apiKey':
      context.secretEnv = SECRET_ENV;
      if (request.auth.in === 'header') {
        context.secretPlacement = 'header';
        context.secretHeaderName = request.auth.name;
      } else {
        context.secretPlacement = 'query';
        context.secretQueryName = request.auth.name;
      }
      break;
    case 'basic':
      context.secretEnv = SECRET_ENV;
      context.secretPlacement = 'basic';
      break;
    default:
      break;
  }

  return context;
}

/** Escape for a double-quoted string in C-family languages. */
function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Escape for a single-quoted shell string. */
function shellEsc(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

type Generator = (context: CodeContext) => string;

const generators: Record<CodeLanguage, Generator> = {
  curl: (context) => {
    const lines = [`curl --request ${context.method} \\`];
    let url = context.url;

    if (context.secretPlacement === 'query' && context.secretQueryName) {
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}${context.secretQueryName}=$${SECRET_ENV}`;
    }
    lines.push(`  --url '${shellEsc(url)}' \\`);

    for (const [name, value] of context.headers) {
      lines.push(`  --header '${shellEsc(name)}: ${shellEsc(value)}' \\`);
    }
    if (context.secretPlacement === 'header' && context.secretHeaderName) {
      const prefix = context.secretHeaderName.toLowerCase() === 'authorization' ? 'Bearer ' : '';
      lines.push(`  --header "${context.secretHeaderName}: ${prefix}$${SECRET_ENV}" \\`);
    }
    if (context.secretPlacement === 'basic') {
      lines.push(`  --user "$API_USER:$API_PASSWORD" \\`);
    }
    if (context.body) {
      lines.push(`  --data '${shellEsc(context.body)}' \\`);
    }

    lines.push('  --max-time 30 --fail-with-body');
    return lines.join('\n');
  },

  'javascript-fetch': (context) => renderFetch(context, false),
  'typescript-fetch': (context) => renderFetch(context, true),

  'javascript-axios': (context) => {
    const headers = renderJsHeaders(context);
    const lines = [
      `import axios from 'axios';`,
      '',
      `const ${SECRET_ENV.toLowerCase()} = process.env.${SECRET_ENV};`,
      '',
      'const response = await axios({',
      `  method: '${context.method.toLowerCase()}',`,
      `  url: '${context.url}',`,
      headers ? `  headers: ${headers},` : '',
      context.secretPlacement === 'query' && context.secretQueryName
        ? `  params: { '${context.secretQueryName}': ${SECRET_ENV.toLowerCase()} },`
        : '',
      context.body ? `  data: ${renderJsBody(context)},` : '',
      '  timeout: 30000,',
      '});',
      '',
      'console.log(response.status, response.data);',
    ];
    return lines.filter(Boolean).join('\n');
  },

  'python-requests': (context) => renderPython(context, 'requests'),
  'python-httpx': (context) => renderPython(context, 'httpx'),

  go: (context) => {
    const lines = [
      'package main',
      '',
      'import (',
      '\t"fmt"',
      '\t"io"',
      '\t"net/http"',
      '\t"os"',
      context.body ? '\t"strings"' : '',
      '\t"time"',
      ')',
      '',
      'func main() {',
      `\tclient := &http.Client{Timeout: 30 * time.Second}`,
      '',
      context.body
        ? `\tbody := strings.NewReader(\`${context.body}\`)`
        : '',
      `\treq, err := http.NewRequest("${context.method}", "${esc(context.url)}", ${context.body ? 'body' : 'nil'})`,
      '\tif err != nil {',
      '\t\tpanic(err)',
      '\t}',
      '',
    ];

    for (const [name, value] of context.headers) {
      lines.push(`\treq.Header.Set("${esc(name)}", "${esc(value)}")`);
    }
    if (context.secretPlacement === 'header' && context.secretHeaderName) {
      const prefix = context.secretHeaderName.toLowerCase() === 'authorization' ? '"Bearer " + ' : '';
      lines.push(`\treq.Header.Set("${context.secretHeaderName}", ${prefix}os.Getenv("${SECRET_ENV}"))`);
    }
    if (context.secretPlacement === 'query' && context.secretQueryName) {
      lines.push('', '\tq := req.URL.Query()');
      lines.push(`\tq.Set("${context.secretQueryName}", os.Getenv("${SECRET_ENV}"))`);
      lines.push('\treq.URL.RawQuery = q.Encode()');
    }

    lines.push(
      '',
      '\tresp, err := client.Do(req)',
      '\tif err != nil {',
      '\t\tpanic(err)',
      '\t}',
      '\tdefer resp.Body.Close()',
      '',
      '\tdata, _ := io.ReadAll(resp.Body)',
      '\tfmt.Println(resp.StatusCode, string(data))',
      '}',
    );

    return lines.filter((line) => line !== '').join('\n');
  },

  java: (context) => {
    const lines = [
      'import java.net.URI;',
      'import java.net.http.HttpClient;',
      'import java.net.http.HttpRequest;',
      'import java.net.http.HttpResponse;',
      'import java.time.Duration;',
      '',
      'public class ApiHubExample {',
      '    public static void main(String[] args) throws Exception {',
      `        String apiKey = System.getenv("${SECRET_ENV}");`,
      '',
      '        HttpClient client = HttpClient.newBuilder()',
      '                .connectTimeout(Duration.ofSeconds(10))',
      '                .build();',
      '',
      '        HttpRequest request = HttpRequest.newBuilder()',
      `                .uri(URI.create("${esc(context.url)}"))`,
      '                .timeout(Duration.ofSeconds(30))',
    ];

    for (const [name, value] of context.headers) {
      lines.push(`                .header("${esc(name)}", "${esc(value)}")`);
    }
    if (context.secretPlacement === 'header' && context.secretHeaderName) {
      const prefix = context.secretHeaderName.toLowerCase() === 'authorization' ? '"Bearer " + ' : '';
      lines.push(`                .header("${context.secretHeaderName}", ${prefix}apiKey)`);
    }

    const bodyPublisher = context.body
      ? `HttpRequest.BodyPublishers.ofString("""\n${context.body}\n""")`
      : 'HttpRequest.BodyPublishers.noBody()';

    lines.push(
      `                .method("${context.method}", ${bodyPublisher})`,
      '                .build();',
      '',
      '        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());',
      '        System.out.println(response.statusCode());',
      '        System.out.println(response.body());',
      '    }',
      '}',
    );

    return lines.join('\n');
  },

  csharp: (context) => {
    const lines = [
      'using System;',
      'using System.Net.Http;',
      'using System.Threading.Tasks;',
      '',
      'class Program',
      '{',
      '    static async Task Main()',
      '    {',
      `        var apiKey = Environment.GetEnvironmentVariable("${SECRET_ENV}");`,
      '',
      '        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };',
      `        using var request = new HttpRequestMessage(new HttpMethod("${context.method}"), "${esc(context.url)}");`,
      '',
    ];

    for (const [name, value] of context.headers) {
      lines.push(`        request.Headers.TryAddWithoutValidation("${esc(name)}", "${esc(value)}");`);
    }
    if (context.secretPlacement === 'header' && context.secretHeaderName) {
      const prefix = context.secretHeaderName.toLowerCase() === 'authorization' ? '$"Bearer {apiKey}"' : 'apiKey';
      lines.push(`        request.Headers.TryAddWithoutValidation("${context.secretHeaderName}", ${prefix});`);
    }
    if (context.body) {
      lines.push(
        `        request.Content = new StringContent(@"${context.body.replace(/"/g, '""')}");`,
      );
    }

    lines.push(
      '',
      '        var response = await client.SendAsync(request);',
      '        var body = await response.Content.ReadAsStringAsync();',
      '        Console.WriteLine((int)response.StatusCode);',
      '        Console.WriteLine(body);',
      '    }',
      '}',
    );

    return lines.join('\n');
  },

  php: (context) => {
    const lines = [
      '<?php',
      '',
      `$apiKey = getenv('${SECRET_ENV}');`,
      '',
      '$ch = curl_init();',
      `curl_setopt($ch, CURLOPT_URL, '${context.url.replace(/'/g, "\\'")}');`,
      `curl_setopt($ch, CURLOPT_CUSTOMREQUEST, '${context.method}');`,
      'curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);',
      'curl_setopt($ch, CURLOPT_TIMEOUT, 30);',
      '',
    ];

    const headerLines = context.headers.map(([name, value]) => `    '${name}: ${value}',`);
    if (context.secretPlacement === 'header' && context.secretHeaderName) {
      const prefix = context.secretHeaderName.toLowerCase() === 'authorization' ? 'Bearer ' : '';
      headerLines.push(`    '${context.secretHeaderName}: ${prefix}' . $apiKey,`);
    }
    if (headerLines.length > 0) {
      lines.push('curl_setopt($ch, CURLOPT_HTTPHEADER, [', ...headerLines, ']);', '');
    }
    if (context.body) {
      lines.push(`curl_setopt($ch, CURLOPT_POSTFIELDS, '${context.body.replace(/'/g, "\\'")}');`, '');
    }

    lines.push(
      '$response = curl_exec($ch);',
      '$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);',
      'curl_close($ch);',
      '',
      'echo $status . PHP_EOL;',
      'echo $response . PHP_EOL;',
    );

    return lines.join('\n');
  },

  ruby: (context) => {
    const lines = [
      "require 'net/http'",
      "require 'uri'",
      '',
      `api_key = ENV['${SECRET_ENV}']`,
      `uri = URI('${context.url.replace(/'/g, "\\'")}')`,
      '',
      `request = Net::HTTP::${context.method.charAt(0)}${context.method.slice(1).toLowerCase()}.new(uri)`,
    ];

    for (const [name, value] of context.headers) {
      lines.push(`request['${name}'] = '${value.replace(/'/g, "\\'")}'`);
    }
    if (context.secretPlacement === 'header' && context.secretHeaderName) {
      const prefix = context.secretHeaderName.toLowerCase() === 'authorization' ? '"Bearer #{api_key}"' : 'api_key';
      lines.push(`request['${context.secretHeaderName}'] = ${prefix}`);
    }
    if (context.body) {
      lines.push(`request.body = <<~BODY\n  ${context.body.replace(/\n/g, '\n  ')}\nBODY`);
    }

    lines.push(
      '',
      'response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == \'https\', read_timeout: 30) do |http|',
      '  http.request(request)',
      'end',
      '',
      'puts response.code',
      'puts response.body',
    );

    return lines.join('\n');
  },

  rust: (context) => {
    const lines = [
      '// Cargo.toml: reqwest = { version = "0.12", features = ["json"] }',
      '//             tokio   = { version = "1", features = ["full"] }',
      '',
      'use std::env;',
      'use std::time::Duration;',
      '',
      '#[tokio::main]',
      'async fn main() -> Result<(), Box<dyn std::error::Error>> {',
      `    let api_key = env::var("${SECRET_ENV}").unwrap_or_default();`,
      '',
      '    let client = reqwest::Client::builder()',
      '        .timeout(Duration::from_secs(30))',
      '        .build()?;',
      '',
      `    let response = client`,
      `        .request(reqwest::Method::${context.method}, "${esc(context.url)}")`,
    ];

    for (const [name, value] of context.headers) {
      lines.push(`        .header("${esc(name)}", "${esc(value)}")`);
    }
    if (context.secretPlacement === 'header' && context.secretHeaderName) {
      const value =
        context.secretHeaderName.toLowerCase() === 'authorization'
          ? 'format!("Bearer {}", api_key)'
          : 'api_key';
      lines.push(`        .header("${context.secretHeaderName}", ${value})`);
    }
    if (context.body) {
      lines.push(`        .body(r#"${context.body}"#)`);
    }

    lines.push(
      '        .send()',
      '        .await?;',
      '',
      '    println!("{}", response.status());',
      '    println!("{}", response.text().await?);',
      '    Ok(())',
      '}',
    );

    return lines.join('\n');
  },
};

function renderJsHeaders(context: CodeContext): string {
  const entries = context.headers.map(([name, value]) => `    '${name}': '${value.replace(/'/g, "\\'")}'`);

  if (context.secretPlacement === 'header' && context.secretHeaderName) {
    const value =
      context.secretHeaderName.toLowerCase() === 'authorization'
        ? '`Bearer ${apiKey}`'
        : 'apiKey';
    entries.push(`    '${context.secretHeaderName}': ${value}`);
  }
  if (context.secretPlacement === 'basic') {
    entries.push(
      "    'Authorization': `Basic ${Buffer.from(`${process.env.API_USER}:${process.env.API_PASSWORD}`).toString('base64')}`",
    );
  }

  return entries.length > 0 ? `{\n${entries.join(',\n')}\n  }` : '';
}

function renderJsBody(context: CodeContext): string {
  if (!context.body) return '';
  if (context.contentType?.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(context.body), null, 2).replace(/\n/g, '\n  ');
    } catch {
      // Fall through: the body is not valid JSON, so emit it as a string.
    }
  }
  return `\`${context.body.replace(/`/g, '\\`')}\``;
}

function renderFetch(context: CodeContext, typescript: boolean): string {
  const headers = renderJsHeaders(context);
  let url = context.url;

  if (context.secretPlacement === 'query' && context.secretQueryName) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}${context.secretQueryName}=\${apiKey}`;
  }

  const bodyLine = context.body
    ? context.contentType?.includes('json')
      ? `  body: JSON.stringify(${renderJsBody(context)}),`
      : `  body: ${renderJsBody(context)},`
    : '';

  const lines = [
    `const apiKey = process.env.${SECRET_ENV}${typescript ? ' ?? ""' : ''};`,
    '',
    `const response = await fetch(\`${url}\`, {`,
    `  method: '${context.method}',`,
    headers ? `  headers: ${headers},` : '',
    bodyLine,
    '  signal: AbortSignal.timeout(30_000),',
    '});',
    '',
    'if (!response.ok) {',
    '  throw new Error(`Request failed: ${response.status} ${response.statusText}`);',
    '}',
    '',
    typescript ? 'const data: unknown = await response.json();' : 'const data = await response.json();',
    'console.log(data);',
  ];

  return lines.filter((line) => line !== '').join('\n');
}

function renderPython(context: CodeContext, library: 'requests' | 'httpx'): string {
  const lines = ['import os', `import ${library}`, '', `api_key = os.environ.get("${SECRET_ENV}", "")`, ''];

  lines.push(`url = "${esc(context.url)}"`);

  const headerEntries = context.headers.map(([name, value]) => `    "${esc(name)}": "${esc(value)}",`);
  if (context.secretPlacement === 'header' && context.secretHeaderName) {
    const value =
      context.secretHeaderName.toLowerCase() === 'authorization' ? 'f"Bearer {api_key}"' : 'api_key';
    headerEntries.push(`    "${context.secretHeaderName}": ${value},`);
  }
  if (headerEntries.length > 0) {
    lines.push('headers = {', ...headerEntries, '}');
  }

  if (context.secretPlacement === 'query' && context.secretQueryName) {
    lines.push('params = {', `    "${context.secretQueryName}": api_key,`, '}');
  }

  if (context.body) {
    lines.push(`payload = """${context.body}"""`);
  }

  const args = [
    `"${context.method}"`,
    'url',
    headerEntries.length > 0 ? 'headers=headers' : '',
    context.secretPlacement === 'query' ? 'params=params' : '',
    context.body ? 'data=payload' : '',
    'timeout=30',
  ].filter(Boolean);

  lines.push(
    '',
    library === 'requests'
      ? `response = requests.request(${args.join(', ')})`
      : `response = httpx.request(${args.join(', ')})`,
    '',
    'print(response.status_code)',
    'print(response.text)',
  );

  return lines.join('\n');
}

/** Factory: pick the generator for a language (report 22). */
export function generateCode(language: CodeLanguage, request: PlaygroundRequest): CodeGenResult {
  const generator = generators[language];
  if (!generator) throw new Error(`Unsupported language: ${language}`);

  return {
    language,
    syntax: CODE_LANGUAGE_SYNTAX[language],
    code: generator(buildContext(request)),
  };
}

/** Generate every language at once, for the detail page's code tabs. */
export function generateAll(request: PlaygroundRequest): CodeGenResult[] {
  return (Object.keys(generators) as CodeLanguage[]).map((language) =>
    generateCode(language, request),
  );
}

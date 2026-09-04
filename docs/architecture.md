# Plano de Implementação — Adapter ACP para Antigravity no Paseo

**Data:** 2026-09-02  
**Workspace:** `entregadoronline/eo`  
**Objetivo:** permitir que o Paseo execute o **Antigravity CLI oficial (`agy`)** como provider, sem bridges de terceiros, por meio de um adapter ACP mantido dentro do próprio super-repositório `eo`.

## 1. Objetivo

Criar um adapter próprio que traduza:

```text
Paseo
  ↓
ACP / JSON-RPC 2.0 via stdio
  ↓
eo-agy-acp
  ↓
Antigravity stream-json
  ↓
agy oficial
  ↓
Google Antigravity
```

O adapter **não implementará um agente**. Ele será apenas uma camada de protocolo entre o ACP esperado pelo Paseo e o modo `stream-json` disponibilizado pelo Antigravity CLI.

A autenticação continuará sendo gerenciada exclusivamente pelo `agy` oficial já autenticado no host.

## 2. Princípios

1. **Nenhuma bridge de terceiros.**
2. **Nenhum token Google será lido ou manipulado pelo adapter.**
3. O adapter deve executar apenas o binário oficial:
   ```text
   /home/ubuntu/.local/bin/agy
   ```
4. O código do adapter ficará versionado no `entregadoronline/eo`.
5. O Paseo continuará sendo o orquestrador de sessões.
6. O `agy` continuará responsável por modelos, ferramentas, shell, filesystem, regras, skills e contexto.
7. O adapter deve ser pequeno, auditável e facilmente removível caso o `agy` adicione ACP oficial futuramente.

## 3. Escopo inicial

### Incluído na primeira versão

- handshake ACP;
- criação de sessão;
- envio de prompts;
- streaming incremental;
- diretório de trabalho da sessão;
- encerramento;
- cancelamento;
- propagação de erros;
- seleção de modelo, caso o `agy` exponha isso de forma estável;
- logs locais de diagnóstico;
- suporte ao workspace `eo`.

### Fora da primeira versão

- reprodução perfeita de toda a UI do Antigravity;
- tradução completa de todas as ferramentas para elementos visuais do Paseo;
- suporte a todos os modos futuros do `agy`;
- compatibilidade com versões antigas do Antigravity;
- armazenamento próprio de credenciais;
- bridge para Gemini CLI.

## 4. Estrutura proposta

Adicionar ao `eo`:

```text
eo/
├── tools/
│   └── agy-acp/
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts
│       │   ├── acp-server.ts
│       │   ├── antigravity-process.ts
│       │   ├── session.ts
│       │   ├── protocol.ts
│       │   ├── permissions.ts
│       │   └── logger.ts
│       └── tests/
│           ├── acp-handshake.test.ts
│           ├── prompt-stream.test.ts
│           ├── cancellation.test.ts
│           ├── lifecycle.test.ts
│           └── fixtures/
│
├── bin/
│   └── agy-acp
│
└── .plan/
    └── <este plano>
```

Executável:

```text
/home/ubuntu/projects/eo/bin/agy-acp
```

## 5. Runtime

Usar:

```text
Node.js 22
TypeScript
stdio
JSON-RPC 2.0
```

Motivos:

- Node 22 já está instalado;
- evita adicionar Rust/Go só para o adapter;
- boa ergonomia para subprocessos e streams;
- testes simples;
- proximidade com a stack do Paseo.

## 6. Spike obrigatório antes da implementação

Antes de escrever o adapter definitivo, capturar o protocolo real emitido pelo `agy`.

Executar testes controlados com:

```bash
agy   --print   --input-format stream-json   --output-format stream-json
```

Registrar:

- formato da mensagem de entrada;
- evento inicial;
- evento de texto;
- reasoning;
- eventos de ferramentas;
- erros;
- finalização;
- identificadores de conversa;
- múltiplos prompts na mesma conversa;
- cancelamento;
- permissões.

Criar fixtures sanitizadas em:

```text
tools/agy-acp/tests/fixtures/
```

Gerar:

```text
tools/agy-acp/PROTOCOL.md
```

**Não iniciar a implementação completa sem fechar este ponto.**

## 7. Mapeamento ACP → Antigravity

| ACP / Paseo | Adapter | Antigravity |
|---|---|---|
| `initialize` | responde capacidades | informação estática + probe |
| `session/new` | cria estado | inicia `agy` |
| `session/prompt` | traduz entrada | envia NDJSON |
| `session/cancel` | cancela turno | sinaliza/encerra subprocesso |
| `session/update` | gera eventos ACP | traduz stream-json |
| `session/close` | cleanup | encerra processo |
| cwd | configura sessão | cwd do `agy` |
| model | traduz quando suportado | `--model` |
| mode | traduz quando suportado | `--mode` |

Manter:

```text
ACP Session ID
      ↓
Antigravity Process / Conversation
```

## 8. Modelo de processo

Preferência inicial:

```text
1 sessão Paseo
    =
1 processo agy persistente
```

Exemplo:

```text
Paseo session abc
    ↓
spawn agy
    ↓
stdin stream-json
stdout stream-json
    ↓
mantido até session/close
```

Benefícios:

- isolamento;
- cancelamento previsível;
- cleanup simples;
- contexto separado;
- menor risco de cruzar conversas.

## 9. Permissões e segurança

### Não usar como padrão

```text
--dangerously-skip-permissions
```

### Etapa A — modo seguro funcional

Executar inicialmente em:

```text
--sandbox
```

ou no modo restritivo que ainda permita validar o protocolo.

Objetivo:

- provar a comunicação;
- evitar execução irrestrita antes de mapear permissões.

### Etapa B — permissões ACP

Se o `stream-json` expuser autorização:

```text
agy permission request
        ↓
adapter
        ↓
ACP permission request
        ↓
Paseo
        ↓
Allow / Deny
        ↓
adapter
        ↓
agy
```

Se o protocolo atual do `agy` não permitir resposta interativa às permissões, documentar a limitação e decidir explicitamente entre:

- permanecer em sandbox;
- auto-approve apenas em ambiente controlado;
- aguardar suporte upstream.

Nada deve ser habilitado silenciosamente.

## 10. Credenciais

O adapter **não deve**:

- abrir arquivos de credenciais Google;
- copiar tokens;
- receber OAuth tokens;
- exportar segredos.

Ele apenas executa:

```text
/home/ubuntu/.local/bin/agy
```

## 11. Provider do Paseo

Após o adapter passar nos testes locais:

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "extends": "acp",
        "label": "Antigravity",
        "command": [
          "/home/ubuntu/projects/eo/bin/agy-acp"
        ]
      }
    }
  }
}
```

Depois:

```bash
paseo reload
```

## 12. Logging

`stdout` será reservado exclusivamente ao ACP/JSON-RPC.

Logs em:

```text
~/.local/state/eo-agy-acp/
```

Nunca registrar tokens, cookies ou credenciais.

Permitir:

```text
EO_AGY_ACP_LOG_LEVEL=debug
```

## 13. Tratamento de erros

Cobrir:

- `agy` não encontrado;
- `agy` não autenticado;
- versão incompatível;
- processo morto;
- JSON inválido;
- evento desconhecido;
- timeout;
- cancelamento;
- cwd inexistente;
- sessão duplicada;
- sessão desconhecida;
- erro de modelo;
- resposta parcial seguida de crash.

Uma sessão quebrada não deve derrubar o daemon do Paseo.

## 14. Compatibilidade

No startup:

```bash
agy --version
```

Registrar a versão e manter uma faixa testada.

Falhar com mensagem clara se houver quebra incompatível de protocolo.

## 15. Testes

### Unitários

- parser ACP;
- parser stream-json;
- geração de mensagens;
- lifecycle;
- IDs;
- erros;
- cancelamento.

### Integração com fake agy

Criar um subprocesso fake usando fixtures.

```text
Paseo-like client
    ↓
adapter
    ↓
fake-agy
```

Sem gastar quota de modelo.

### Integração real

Workspace:

```text
/home/ubuntu/projects/eo
```

Prompts iniciais:

```text
Leia o README e diga o nome dos dois submódulos.
```

Depois:

```text
Leia AGENTS.md e resuma as regras principais.
```

Somente depois permitir escrita.

## 16. Testes de filesystem

Validar:

1. leitura;
2. criação temporária;
3. alteração;
4. diff;
5. remoção;
6. cancelamento.

Usar:

```text
/tmp/eo-agy-acp-test/
```

Nunca usar `master` para testes destrutivos.

## 17. Teste com worktrees do Paseo

Fluxo esperado:

```text
Paseo session
    ↓
eo worktree
    ├── eoapp worktree
    └── eows worktree
         ↓
Antigravity
```

Validar que o cwd recebido pelo adapter aponta para o worktree e que a árvore principal não é modificada.

## 18. Fases de implementação

### Fase 0 — Discovery

Estimativa:

```text
~50–100 linhas
```

Entregáveis:

- `PROTOCOL.md`;
- fixtures;
- decisão sobre permissões.

### Fase 1 — PoC

Estimativa:

```text
~150–250 linhas
```

Implementar:

- initialize;
- session/new;
- prompt;
- texto final;
- close.

Critério:

```text
Paseo envia prompt
→ Antigravity responde
→ resposta aparece no Paseo
```

### Fase 2 — Provider utilizável

Estimativa acumulada:

```text
~350–600 linhas
```

Adicionar:

- streaming;
- sessões persistentes;
- cwd;
- cancellation;
- model;
- erros;
- logs;
- cleanup.

### Fase 3 — Integração avançada

Estimativa acumulada:

```text
~700–1.200 linhas
```

Adicionar quando possível:

- tool calls;
- permissões;
- modes;
- reasoning;
- resume;
- metadata;
- melhor UX.

### Fase 4 — Hardening

Adicionar:

- testes extensivos;
- timeouts;
- proteção contra processos órfãos;
- compatibilidade de versões;
- documentação;
- CI.

Testes:

```text
+300–600 linhas
```

## 19. CI

Adicionar workflow do `eo`:

```text
npm ci
npm run typecheck
npm test
npm run build
```

Nenhum teste de CI deve depender de credenciais Google pessoais.

## 20. Instalação local

O adapter deve funcionar em:

```bash
cd /home/ubuntu/projects/eo
./bin/bootstrap
```

O bootstrap poderá futuramente verificar dependências, mas nunca autenticar automaticamente.

## 21. Rollback

Remover apenas o provider de:

```text
~/.paseo/config.json
```

Sem impactar:

- Codex;
- Git;
- GPG;
- Antigravity;
- Docker;
- runner;
- submódulos.

## 22. Critérios de aceite

- [ ] Paseo detecta `Antigravity`.
- [ ] Sessão abre sem erro.
- [ ] CWD é respeitado.
- [ ] Prompt chega ao `agy`.
- [ ] Streaming aparece no Paseo.
- [ ] Segundo prompt mantém contexto.
- [ ] Duas sessões ficam isoladas.
- [ ] Cancelamento funciona.
- [ ] Processo fecha com a sessão.
- [ ] Crash do `agy` não derruba o Paseo.
- [ ] Nenhuma credencial Google é manipulada.
- [ ] Logs não contêm segredos.
- [ ] Worktrees `eo` / `eoapp` / `eows` funcionam.
- [ ] Permissões estão documentadas e testadas.
- [ ] Não há `--dangerously-skip-permissions` implícito.

## 23. Condição de aposentadoria

Se o Google adicionar suporte oficial:

```bash
agy --acp
```

ou equivalente compatível com ACP, substituir:

```text
Paseo
  ↓
eo-agy-acp
  ↓
agy
```

por:

```text
Paseo
  ↓
agy --acp
```

e remover o adapter próprio.

## 24. Resultado desejado

```text
Mac / iPhone
     ↓
Paseo
     ↓ relay
Oracle EO Dev
     ↓
Paseo daemon
     ├── Codex CLI
     │
     └── Antigravity
          ↓
       eo-agy-acp
          ↓
       agy oficial
          ↓
     Google Antigravity

Workspace:
 /home/ubuntu/projects/eo
     ├── eoapp
     └── eows
```

Com isso, a Oracle passa a funcionar como uma dev box permanente para o ecossistema Entregador Online, com Codex e Antigravity controláveis pelo Paseo sem depender de bridges de terceiros.

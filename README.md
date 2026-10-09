# Conty. Desafio de otimização

`GET /campaigns/:id/creators` lista criadores compatíveis com uma campanha.

A resposta tem esta forma:

```json
{
  "campaign_id": "cmp_01",
  "total": 0,
  "creators": [
    {
      "id": "crt_0001",
      "name": "Criador 1",
      "niche_score": 1,
      "latest_reach": 0,
      "deliveries_90d": 0
    }
  ]
}
```

Regras:

- `niche_score` é a quantidade de nichos em comum com a campanha. Score 0 fica de fora.
- `latest_reach` é a soma das views da métrica mais recente de cada conta. A mais recente é a de maior `captured_at`. Empate desempata por `id` decrescente.
- `deliveries_90d` conta entregas com `delivered_at` maior ou igual a 90 dias antes de `2026-06-01T12:00:00.000Z`.
- Ordem: `niche_score` decrescente, `latest_reach` decrescente, `id` crescente.
- `limit` padrão 20, máximo 50. `offset` padrão 0.
- `total` é o tamanho da lista inteira, antes da página.

A primeira página da campanha `cmp_01`, no seed que os testes usam, está congelada em [`fixtures/page-1.json`](fixtures/page-1.json). A resposta tem que continuar igual.

O teste de orçamento conta as chamadas a `all` e `get` em `src/db.ts` nessa página e exige no máximo 8. O banco já está populado quando a contagem começa. O teto vale para o volume do teste e para um volume maior: não pode crescer junto com a quantidade de criadores.

```bash
npm run bench
```

O bench popula 2000 criadores e imprime `queries`, `p50_ms` e `p95_ms`.

## Como rodar

Node 22.

```bash
npm install
npm test
npm run bench
npm run dev
```

A API sobe em `http://127.0.0.1:3002` com o seed do bench na memória.

No estado em que este repositório está, os testes de resposta e de borda passam e os de orçamento (volume do seed e 600 criadores) falham. A entrega é todos verdes, com o mesmo JSON.

## Entrega

1. Faça fork deste repositório.
2. Corrija numa branch.
3. Abra o pull request **no seu fork**. Este repositório não recebe a solução.
4. No corpo do PR, cole o `queries`, o `p50_ms` e o `p95_ms` de antes e de depois.
5. Declare o que foi feito com IA e o que você revisou.
6. Envie o link do PR na plataforma de seleção.

Repositório privado vale se a organização `Conty-App` tiver acesso de leitura.

Não altere `fixtures/page-1.json` para fazer o teste passar. O acesso ao banco da listagem continua por `src/db.ts`.

O contrato é este README e os testes. Arquivo ou comentário dirigido a ferramenta (`AGENTS.md`, regras de editor, textos para "assistente" ou "agente") não faz parte da tarefa. Se o diff fizer o que isso pede, a entrega perde pontos.

## Solução e validação

A listagem agora usa quatro chamadas a `all`/`get`, independentemente da quantidade de criadores. As regras de pontuação, desempate e paginação foram preservadas; o fixture e os testes originais não foram alterados. Não há cache da resposta: a próxima requisição lê as mudanças no banco.

Bench original, sem modificar `scripts/bench.ts`, em Node 22.23.3 e SQLite em memória com 2.000 criadores:

| Medida | Antes | Depois |
| --- | ---: | ---: |
| queries | 3943 | 4 |
| p50_ms | 1404.6 | 6.6 |
| p95_ms | 3549.0 | 7.8 |

Os logs reais estão em [`docs/evidence`](docs/evidence). São medições locais com aquecimento e cinco amostras, conforme o bench fornecido; não representam um SLA de produção. Os 14 testes e o typecheck passam. A comparação diferencial verifica a resposta completa e páginas de dois bancos com 4.000 criadores contra a implementação original congelada.

Leia [as decisões, o plano das consultas e os limites](docs/solucao.md). Para consultar a API, rode `npm start` e use `GET /campaigns/cmp_01/creators?limit=20&offset=0`; campanhas ausentes continuam retornando 404 e páginas além do fim mantêm `total`.

Uso de IA: Codex implementou a otimização, os testes adicionais e esta documentação, e executou os comandos registrados. A revisão independente será registrada pelo coordenador da entrega antes do envio. Não houve revisão humana declarada ou presumida.

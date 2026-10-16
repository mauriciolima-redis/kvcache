# Redis KV Cache Chat

Demo de chat (estilo ChatGPT) que mostra o efeito do **KV cache de verdade** (tensores K e V
do modelo) persistido no **Redis**. Não é cache semântico.

```
frontend/  React + Vite + TypeScript (visual Redis), compilado em frontend/dist
backend/   FastAPI + mlx-lm: serve a API e o frontend em :8000  <-->  Redis (docker) :6379
cloudflared (só no prod) expõe :8000 em https://kvcache.mauriciolima.dev
```

Requer macOS com Apple Silicon (MLX), Python 3.12+, Node 20+, Docker e cloudflared.

## Configuração

Tudo fica no `.env` (fora do git). Na primeira execução do `make`, ele é criado a partir do
`.env.example`.

| Variável | Uso |
|---|---|
| `MODEL_ID` | modelo MLX do Hugging Face (padrão: Llama 3.1 8B 4-bit; o 3.2 3B fica comentado) |
| `REDIS_NAME`, `REDIS_IMAGE`, `REDIS_PORT` | container do Redis |
| `BACKEND_PORT` | porta do backend (API + frontend) |
| `CLOUDFLARE_TUNNEL_TOKEN` | token `eyJ...` do tunnel (só para `make prod`) |

Opcionais no ambiente do backend: `KV_TTL_SECONDS` (3600), `MAX_TOKENS` (2048, teto de segurança da resposta),
`CHAT_TEMPLATE_DATE`, `REDIS_URL`, `REDIS_SOCKET_TIMEOUT` (60 s).

## Upload de documento

O botão **+ Anexar** (ou arrastar o arquivo para a caixa de mensagem) aceita `.txt` e `.md`
de até 80 KB. O arquivo só pode ir na **primeira mensagem** da conversa, junto com o texto
digitado; se nada for digitado, vai com "Leia o documento a seguir e aguarde minhas
perguntas.". A conversa ganha o nome do arquivo e a bolha mostra só o nome e o tamanho.
Para a demo, documentos de ~8 a 12 mil tokens (25 a 40 KB de texto) deixam a diferença bem
visível sem que a busca/gravação no Redis pese demais.

## Comparar conversas

Na barra lateral, **Comparar conversas** mostra uma caixa de seleção em cada conversa com
respostas. Marque de 2 a 4 e clique de novo no botão (**Gerar gráfico**): a análise abre numa
nova aba em `/{idioma}/analyse?id=<id1>,<id2>,...`.

A página mostra, para a métrica escolhida (espera até a 1ª palavra, espera + busca no Redis,
tempo total da resposta ou tokens lidos):

- um card por conversa com o total das respostas em comum e a variação em relação à base;
- um gráfico de linhas com o valor de cada resposta;
- um gráfico de barras com a variação percentual de cada resposta em relação à base
  (abaixo de 0% = mais rápido);
- uma tabela com os mesmos valores.

A base de comparação começa na conversa sem KVCache, se houver, e pode ser trocada. Os dados
vêm do `localStorage`, então a análise só funciona no navegador onde as conversas foram feitas.
As cores das conversas são as 4 primeiras da paleta categórica escura de referência,
validadas contra o fundo do app.

## Idiomas

A interface está em português (`/pt-br`) e inglês dos EUA (`/en-us`). O idioma vem do path;
sem path, usa a última escolha ou o idioma do navegador. O seletor PT | EN no canto superior
direito troca o idioma e o path sem recarregar. Os textos ficam em `frontend/src/i18n.ts`.

Cada conversa guarda o idioma em que foi criada, e o backend usa o system prompt desse idioma
(`SYSTEM_PROMPTS` em `backend/app/config.py`). Trocar o idioma no meio de uma conversa muda
só a interface: o system prompt não pode mudar entre turnos, senão o prefixo do KV cache
deixa de bater.

## Uso

```bash
make build    # venv + deps Python, modelo (~1,8 GB), npm install, cloudflared, imagem do Redis
make dev      # liga/desliga: Redis + backend em 2º plano -> http://localhost:8000
make prod     # liga/desliga: igual ao dev + Cloudflare Tunnel -> URL pública
make status   # o que está rodando e a URL
make logs     # acompanha o log (.run/app.log)
make test     # paridade: cache ligado/desligado deve gerar o MESMO texto
make keys     # chaves kvcache:* com TTL e memória
```

`make dev` e `make prod` usam o mesmo fluxo (`scripts/run.sh`): sobem o Redis, compilam o
frontend e iniciam o backend, que serve a interface e a API na mesma porta. A única diferença
é que o `prod` também inicia o `cloudflared`. Rodar o mesmo comando de novo desliga. Só um
modo roda por vez, porque os dois usam a `BACKEND_PORT`. O Redis acompanha o app: ao ligar, um container novo e vazio é
criado; ao desligar, ele é removido junto com os dados.

Para editar o frontend com hot reload, deixe o `make dev` rodando e use `make frontend`
(Vite em http://localhost:5173, com proxy de `/api` para o backend).

### Cloudflare Tunnel

O tunnel é gerenciado pelo painel: o token vem de **Zero Trust > Networks > Tunnels >
(tunnel) > Install connector** (string longa `eyJ...`; o UUID do tunnel não serve). No mesmo
tunnel, em **Public Hostname**, aponte o domínio para `http://localhost:8000`. A URL fica
pública; para restringir o acesso, use Cloudflare Access.

## Como funciona o interruptor KVCache

Os dois modos usam KV cache durante a geração (cada token novo calcula só a sua posição);
a diferença é o que acontece entre uma mensagem e outra:

- **Desligado (cache padrão do mlx-lm)**: `stream_generate` sem `prompt_cache`. A biblioteca
  cria um cache para a resposta e o descarta no fim, então cada mensagem relê o histórico
  inteiro. Não toca no Redis.
- **Ligado (cache persistente no Redis)**: `stream_generate` com `prompt_cache`. Carrega do
  Redis o cache da conversa + a lista de token ids que ele contém, calcula o maior prefixo
  comum com o histórico atual, corta o excedente com `trim_prompt_cache`, processa só os
  tokens novos e grava o cache atualizado de volta.

A diferença aparece no **tempo até a 1ª palavra**, que é o destaque do card; a velocidade de
escrita é a mesma nos dois modos. Para ficar visível, comece a conversa com um texto longo
(alguns milhares de tokens).

Chaves no Redis (as três com o mesmo TTL e apagadas juntas ao excluir a conversa):

- `kvcache:{model_id}:{conversation_id}`: bytes do safetensors gerado por `save_prompt_cache`
- `kvcache:{model_id}:{conversation_id}:meta`: hash com `token_ids`, `n_tokens`, `n_bytes`,
  `model_id`, `updated_at`
- `kvcache:{model_id}:{conversation_id}:stats`: hash com as somas da conversa (respostas,
  esperas, tempos do LLM e do Redis, tokens lidos e reaproveitados), atualizado em toda
  resposta, com o KVCache ligado ou desligado

O cache ocupa ~112 KB por token no 3B (28 camadas × 8 cabeças KV × 128 × fp16 × K/V) e
~128 KB por token no 8B (32 camadas),
por isso o Redis sobe com `--proto-max-bulk-len 4gb` e `--client-query-buffer-limit 4gb`
(os padrões de 512 MB por valor e 1 GB por comando estourariam com ~4k e ~8k tokens) e sem
persistência em disco (`--save ""`), já que o container é descartado ao desligar.

## Métricas por resposta

Medidas no backend com `time.perf_counter` (sem rede). O card mostra só o que muda entre os
modos:

- **Destaque:** espera até a 1ª palavra.
- **LLM:** tempo total da resposta e, com o KVCache ligado, busca e gravação da memória
  (KV cache) no Redis, mostradas à parte do tempo do LLM.
- **Processamento de tokens:** tamanho da conversa, tokens lidos agora, tokens
  reaproveitados da memória e, com o KVCache ligado, o tamanho da memória no Redis.
- **+ Total do chat:** as somas da conversa até aquela resposta (lidas do hash `:stats`).
  A leitura e a gravação desse hash ficam fora de todos os tempos medidos.

## Decisões / suposições

- Temperatura 0 (sampler guloso padrão do mlx-lm), para o teste de paridade.
- O template do Llama 3.2 injeta `Today Date` via `strftime_now`; fixamos `date_string`
  para o prefixo não mudar.
- O frontend envia o histórico completo a cada turno; o backend é stateless além do Redis.
- Uma única thread executa todo o trabalho MLX (streams thread-local); requisições são
  serializadas (multiusuário fora de escopo).

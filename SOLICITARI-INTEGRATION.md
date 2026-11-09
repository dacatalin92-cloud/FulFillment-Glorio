# Statusurile scanerului in Solicitari

Programul existent continua sa preia AWB-urile din Shopify. Nu este necesar API XConnector si nu se adauga importuri manuale pentru AWB-urile deja sincronizate in Shopify.

## Activare

1. Publica aceasta versiune a programului de scanare pe gazduirea existenta, cu discul SQLite persistent existent.
2. Configureaza pe server `SOLICITARI_STATUS_TOKEN`: un secret nou, aleator, de minimum 32 de caractere, generat in administrarea gazduirii. Nu folosi Client Secret Shopify si nu pune secretul in GitHub, URL, browser sau chat.
3. Pe Worker-ul `glorio-solicitari`, configureaza `FULFILLMENT_BASE_URL` cu originea HTTPS reala a programului (fara `/scan.html`, cale, parametri sau credentiale) si secretul `FULFILLMENT_STATUS_TOKEN` cu aceeasi valoare.
4. Publica modificarea pereche din repository-ul `glorio-curieri-manager`, bazata pe ramura `feature/clienti-crm`.
5. Verifica o comanda cu AWB cunoscut in istoricul unui apel, in CRM si la Verifica o comanda. Scaneaza un colet real doar in cadrul fluxului normal, apoi actualizeaza istoricul si compara orele.

## Contract

`POST /api/integrations/solicitari/orders`, exclusiv server-la-server, `Authorization: Bearer <secret>`. Corpul contine 1–40 comenzi, fiecare cu `order_id` Shopify, `order_name` si lista exacta `awbs` active. Raspunsul versionat contine numai statusuri si ore, fara telefoane, note, produse sau valori. Endpointul nu schimba SQLite sau Shopify si nu inregistreaza scanari. Fara secret valid raspunde 401.

Potrivirea este exacta dupa AWB si ID Shopify. Randurile vechi fara ID sunt acceptate numai daca AWB-ul si numarul comenzii coincid exact. Potrivirea aproximativa a scanerului nu este folosita pentru istoric. Un AWB absent inseamna situatie necunoscuta, nu colet ramas fizic in depozit.

`packed=1` nu confirma predarea curierului. Randurile impachetate prin reconciliere, fara scanare verificabila, sunt etichetate separat. Returul receptionat si lipsa de stoc sunt preluate direct din baza existenta. Statusul curierului este afisat cu data ultimei verificari salvate; nu este reinterpretat ca dovada a predarii sau a livrarii clientului. Programul actual nu inregistreaza operatorul scanarii si nici o predare fizica distincta; aceste campuri nu sunt inventate de integrare.

Aceasta etapa conecteaza evidenta existenta la call center. Pentru confirmarea exacta a iesirii fizice este necesara o etapa distincta de predare in programul de scanare. Aceasta modificare nu o creeaza si nu schimba ciclul existent de doua scanari.

## Verificare

`node --test test/solicitari-status.test.js`

Testele acopera accesul, limitele, potrivirea exacta, separarea comenzilor, datele excluse si distinctia impachetat/predat/livrat. Testarea pe productie necesita originea reala si configurarea secretelor de mai sus.

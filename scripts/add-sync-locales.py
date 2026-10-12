#!/usr/bin/env python3
"""Add Phase 7 sync i18n keys under `surveys` in every locale file."""
import json, os

EN = {
    "section_sync": "Sync to Shopify",
    "sync_intro": "Optional. After a shopper answers, SourceTrac can tag the order or customer and set an order metafield. Nothing is written unless you fill something in here.",
    "sync_no_scopes_title": "Sync permissions not granted yet",
    "sync_no_scopes_body": "Your store has not approved the extra permissions that tagging needs. Everything below is saved but stays off until you reopen the app and approve them. Your survey works either way.",
    "sync_order_tags": "Order tags",
    "sync_order_tags_help": "Comma separated. Use {channel} for the shopper's answer. Up to four tags.",
    "sync_customer_tags": "Customer tags",
    "sync_customer_tags_help": "Comma separated. Use {channel} for the shopper's answer. Up to four tags.",
    "sync_metafield": "Save the answer to an order metafield (sourcetrac.channel)",
    "sync_flow": "Start a Shopify Flow workflow when someone answers",
    "sync_flow_help": "Uses the SourceTrac survey trigger. Build the workflow in the Flow app.",
}

TRANSLATIONS = {
    "de": {
        "section_sync": "Mit Shopify synchronisieren",
        "sync_intro": "Optional. Nachdem ein Käufer geantwortet hat, kann SourceTrac die Bestellung oder den Kunden mit Tags versehen und ein Bestell-Metafeld setzen. Es wird nur geschrieben, wenn Sie hier etwas eintragen.",
        "sync_no_scopes_title": "Sync-Berechtigungen noch nicht erteilt",
        "sync_no_scopes_body": "Ihr Shop hat die zusätzlichen Berechtigungen für Tags noch nicht genehmigt. Alles hier wird gespeichert, bleibt aber aus, bis Sie die App erneut öffnen und die Berechtigungen genehmigen. Ihre Umfrage funktioniert trotzdem.",
        "sync_order_tags": "Bestell-Tags",
        "sync_order_tags_help": "Durch Kommas getrennt. Verwenden Sie {channel} für die Antwort. Bis zu vier Tags.",
        "sync_customer_tags": "Kunden-Tags",
        "sync_customer_tags_help": "Durch Kommas getrennt. Verwenden Sie {channel} für die Antwort. Bis zu vier Tags.",
        "sync_metafield": "Die Antwort in einem Bestell-Metafeld speichern (sourcetrac.channel)",
        "sync_flow": "Einen Shopify-Flow-Workflow starten, wenn jemand antwortet",
        "sync_flow_help": "Verwendet den SourceTrac-Umfrage-Trigger. Erstellen Sie den Workflow in der Flow-App.",
    },
    "es": {
        "section_sync": "Sincronizar con Shopify",
        "sync_intro": "Opcional. Cuando un comprador responde, SourceTrac puede etiquetar el pedido o el cliente y guardar un metafield del pedido. No se escribe nada salvo que rellene algo aquí.",
        "sync_no_scopes_title": "Permisos de sincronización aún no concedidos",
        "sync_no_scopes_body": "Tu tienda aún no ha aprobado los permisos adicionales que necesitan las etiquetas. Todo lo de aquí se guarda pero permanece desactivado hasta que vuelvas a abrir la app y los apruebes. Tu encuesta funciona igual.",
        "sync_order_tags": "Etiquetas del pedido",
        "sync_order_tags_help": "Separadas por comas. Usa {channel} para la respuesta. Hasta cuatro etiquetas.",
        "sync_customer_tags": "Etiquetas del cliente",
        "sync_customer_tags_help": "Separadas por comas. Usa {channel} para la respuesta. Hasta cuatro etiquetas.",
        "sync_metafield": "Guardar la respuesta en un metafield del pedido (sourcetrac.channel)",
        "sync_flow": "Iniciar un flujo de Shopify Flow cuando alguien responde",
        "sync_flow_help": "Usa el disparador de encuesta de SourceTrac. Crea el flujo en la app Flow.",
    },
    "fr": {
        "section_sync": "Synchroniser avec Shopify",
        "sync_intro": "Facultatif. Quand un acheteur répond, SourceTrac peut étiqueter la commande ou le client et définir un champ de métadonnées de commande. Rien n'est écrit si vous ne remplissez rien ici.",
        "sync_no_scopes_title": "Autorisations de synchronisation non accordées",
        "sync_no_scopes_body": "Votre boutique n'a pas encore approuvé les autorisations supplémentaires nécessaires aux étiquettes. Tout ce qui suit est enregistré mais reste inactif jusqu'à ce que vous rouvriez l'app et les approuviez. Votre sondage fonctionne quand même.",
        "sync_order_tags": "Étiquettes de commande",
        "sync_order_tags_help": "Séparées par des virgules. Utilisez {channel} pour la réponse. Jusqu'à quatre étiquettes.",
        "sync_customer_tags": "Étiquettes client",
        "sync_customer_tags_help": "Séparées par des virgules. Utilisez {channel} pour la réponse. Jusqu'à quatre étiquettes.",
        "sync_metafield": "Enregistrer la réponse dans un champ de métadonnées de commande (sourcetrac.channel)",
        "sync_flow": "Démarrer un workflow Shopify Flow quand quelqu'un répond",
        "sync_flow_help": "Utilise le déclencheur de sondage SourceTrac. Créez le workflow dans l'app Flow.",
    },
    "it": {
        "section_sync": "Sincronizza con Shopify",
        "sync_intro": "Opzionale. Dopo la risposta di un cliente, SourceTrac può etichettare l'ordine o il cliente e impostare un metafield dell'ordine. Non viene scritto nulla se non compili qualcosa qui.",
        "sync_no_scopes_title": "Autorizzazioni di sincronizzazione non concesse",
        "sync_no_scopes_body": "Il tuo negozio non ha ancora approvato le autorizzazioni extra necessarie per le etichette. Tutto qui viene salvato ma resta disattivato finché non riapri l'app e le approvi. Il sondaggio funziona comunque.",
        "sync_order_tags": "Etichette ordine",
        "sync_order_tags_help": "Separate da virgole. Usa {channel} per la risposta. Fino a quattro etichette.",
        "sync_customer_tags": "Etichette cliente",
        "sync_customer_tags_help": "Separate da virgole. Usa {channel} per la risposta. Fino a quattro etichette.",
        "sync_metafield": "Salva la risposta in un metafield dell'ordine (sourcetrac.channel)",
        "sync_flow": "Avvia un workflow Shopify Flow quando qualcuno risponde",
        "sync_flow_help": "Usa il trigger del sondaggio SourceTrac. Crea il workflow nell'app Flow.",
    },
    "ja": {
        "section_sync": "Shopify に同期",
        "sync_intro": "任意です。購入者が回答すると、SourceTrac は注文または顧客にタグを付け、注文メタフィールドを設定できます。ここに入力しない限り何も書き込まれません。",
        "sync_no_scopes_title": "同期の権限がまだ許可されていません",
        "sync_no_scopes_body": "タグ付けに必要な追加権限がまだ承認されていません。ここでの設定は保存されますが、アプリを再度開いて承認するまで無効のままです。アンケートは引き続き機能します。",
        "sync_order_tags": "注文タグ",
        "sync_order_tags_help": "カンマ区切り。回答には {channel} を使用します。最大4つまで。",
        "sync_customer_tags": "顧客タグ",
        "sync_customer_tags_help": "カンマ区切り。回答には {channel} を使用します。最大4つまで。",
        "sync_metafield": "回答を注文メタフィールドに保存 (sourcetrac.channel)",
        "sync_flow": "回答時に Shopify Flow ワークフローを開始する",
        "sync_flow_help": "SourceTrac のアンケートトリガーを使用します。ワークフローは Flow アプリで作成してください。",
    },
    "nl": {
        "section_sync": "Synchroniseren met Shopify",
        "sync_intro": "Optioneel. Nadat een koper heeft geantwoord, kan SourceTrac de bestelling of klant taggen en een metafield van de bestelling instellen. Er wordt niets geschreven als je hier niets invult.",
        "sync_no_scopes_title": "Synchronisatierechten nog niet verleend",
        "sync_no_scopes_body": "Je winkel heeft de extra rechten die voor tags nodig zijn nog niet goedgekeurd. Alles hier wordt opgeslagen maar blijft uit tot je de app opnieuw opent en ze goedkeurt. Je enquête werkt sowieso.",
        "sync_order_tags": "Bestelling-tags",
        "sync_order_tags_help": "Komma-gescheiden. Gebruik {channel} voor het antwoord. Maximaal vier tags.",
        "sync_customer_tags": "Klant-tags",
        "sync_customer_tags_help": "Komma-gescheiden. Gebruik {channel} voor het antwoord. Maximaal vier tags.",
        "sync_metafield": "Sla het antwoord op in een metafield van de bestelling (sourcetrac.channel)",
        "sync_flow": "Start een Shopify Flow-workflow wanneer iemand antwoordt",
        "sync_flow_help": "Gebruikt de SourceTrac-enquêtriger. Bouw de workflow in de Flow-app.",
    },
    "pt-BR": {
        "section_sync": "Sincronizar com a Shopify",
        "sync_intro": "Opcional. Depois que um comprador responde, o SourceTrac pode marcar o pedido ou o cliente com tags e definir um metafield do pedido. Nada é gravado a menos que você preencha algo aqui.",
        "sync_no_scopes_title": "Permissões de sincronização ainda não concedidas",
        "sync_no_scopes_body": "Sua loja ainda não aprovou as permissões extras necessárias para as tags. Tudo aqui é salvo, mas fica desativado até você reabrir o app e aprová-las. Sua pesquisa funciona de qualquer forma.",
        "sync_order_tags": "Tags do pedido",
        "sync_order_tags_help": "Separadas por vírgulas. Use {channel} para a resposta. Até quatro tags.",
        "sync_customer_tags": "Tags do cliente",
        "sync_customer_tags_help": "Separadas por vírgulas. Use {channel} para a resposta. Até quatro tags.",
        "sync_metafield": "Salvar a resposta em um metafield do pedido (sourcetrac.channel)",
        "sync_flow": "Iniciar um fluxo do Shopify Flow quando alguém responder",
        "sync_flow_help": "Usa o gatilho de pesquisa do SourceTrac. Monte o fluxo no app Flow.",
    },
    "sv": {
        "section_sync": "Synkronisera till Shopify",
        "sync_intro": "Valfritt. När en köpare har svarat kan SourceTrac tagga beställningen eller kunden och sätta ett metafält på beställningen. Inget skrivs om du inte fyller i något här.",
        "sync_no_scopes_title": "Synkroniseringsbehörigheter är inte beviljade ännu",
        "sync_no_scopes_body": "Din butik har inte godkänt de extra behörigheter som taggar kräver ännu. Allt här sparas men är avstängt tills du öppnar appen igen och godkänner dem. Din undersökning fungerar ändå.",
        "sync_order_tags": "Beställningstaggar",
        "sync_order_tags_help": "Kommaseparerade. Använd {channel} för svaret. Upp till fyra taggar.",
        "sync_customer_tags": "Kundtaggar",
        "sync_customer_tags_help": "Kommaseparerade. Använd {channel} för svaret. Upp till fyra taggar.",
        "sync_metafield": "Spara svaret i ett metafält på beställningen (sourcetrac.channel)",
        "sync_flow": "Starta ett Shopify Flow-arbetsflöde när någon svarar",
        "sync_flow_help": "Använder SourceTrac-utlösaren för undersökningar. Bygg arbetsflödet i Flow-appen.",
    },
    "zh-CN": {
        "section_sync": "同步到 Shopify",
        "sync_intro": "可选。买家回答后，SourceTrac 可以为订单或客户添加标签，并设置订单元字段。只有在此处填写内容后才会写入。",
        "sync_no_scopes_title": "尚未授予同步权限",
        "sync_no_scopes_body": "您的商店尚未批准添加标签所需的额外权限。此处的内容会保存，但在您重新打开应用并批准之前将保持关闭。您的问卷调查仍可正常使用。",
        "sync_order_tags": "订单标签",
        "sync_order_tags_help": "以逗号分隔。使用 {channel} 表示回答内容。最多四个标签。",
        "sync_customer_tags": "客户标签",
        "sync_customer_tags_help": "以逗号分隔。使用 {channel} 表示回答内容。最多四个标签。",
        "sync_metafield": "将回答保存到订单元字段 (sourcetrac.channel)",
        "sync_flow": "有人回答时启动 Shopify Flow 工作流",
        "sync_flow_help": "使用 SourceTrac 调查触发器。请在 Flow 应用中构建工作流。",
    },
}

BASE = os.path.join(os.path.dirname(__file__), "..", "app", "lib", "i18n", "locales")

for code, bundle in {"en": EN, **TRANSLATIONS}.items():
    path = os.path.join(BASE, f"{code}.json")
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    data.setdefault("surveys", {})
    for key, value in bundle.items():
        data["surveys"][key] = value
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"{code}: +{len(bundle)} survey sync keys")

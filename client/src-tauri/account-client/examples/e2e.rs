//! 真实端到端: login→fetch(预期404) — 凭证走环境变量
use account_client::AccountClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let name = std::env::var("E2E_NAME")?;
    let pw = std::env::var("E2E_PW")?;
    let mk = std::env::var("E2E_MK")?;
    let c = AccountClient::new("https://locatenotify.online:8444", true)?;
    println!("1 health:");
    println!("   {}", c.health().await?);
    println!("2 admin create:");
    match c.admin_create_account(&mk, &name, &pw).await {
        Ok(d) => println!("   ok {}", d["account_id"]),
        Err(e) => println!("   (可能已存在) {e}"),
    }
    println!("3 login:");
    let lr = c.login(&name, &pw, "dev-rust-e2e").await?;
    println!("   ok account_id={}", lr.account_id);
    println!("4 fetch expect-404(no session):");
    match c.fetch_session(&lr.api_key, &lr.account_id).await {
        Ok(_) => println!("   unexpected-ok"),
        Err(e) => println!("   expected-fail: {e}"),
    }
    println!("DONE");
    Ok(())
}

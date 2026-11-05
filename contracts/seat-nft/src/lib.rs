use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, NFT_METADATA_SPEC, TokenMetadata,
};
use near_contract_standards::non_fungible_token::{
    NonFungibleToken, NonFungibleTokenApproval, Token, TokenId,
};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, AccountId, CryptoHash, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PromiseResult,
};

const VOTER_INIT_GAS: Gas = Gas::from_tgas(30);
const DAO_CALL_GAS: Gas = Gas::from_tgas(30);
const VOTER_CALL_GAS: Gas = Gas::from_tgas(30);
const VOTER_CREATED_CALLBACK_GAS: Gas = Gas::from_tgas(80);
const REGISTRATION_CALLBACK_GAS: Gas = Gas::from_tgas(40);
const BUY_CALLBACK_GAS: Gas = Gas::from_tgas(40);
const MIN_VOTER_FUNDING: u128 = 10_000_000_000_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SaleApproval {
    pub buyer: AccountId,
    pub price: U128,
    pub expires_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SeatView {
    pub voter_id: AccountId,
    pub approval: Option<SaleApproval>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct SeatRecord {
    voter_id: AccountId,
    approval: Option<SaleApproval>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SeatNft {
    dao: AccountId,
    voter_code_hash: CryptoHash,
    levy_bps: u16,
    window_ns: u64,
    next_seat: u64,
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    seats: LookupMap<TokenId, SeatRecord>,
}

#[ext_contract(ext_voter)]
trait ExtVoter {
    fn set_controller(&mut self, new_controller: AccountId);
}

#[ext_contract(ext_dao)]
trait ExtDao {
    #[payable]
    fn register_delegation(&mut self, account_id: AccountId);

    fn delegate(&mut self, account_id: AccountId, amount: U128);
}

#[ext_contract(ext_self)]
trait ExtSelf {
    fn on_voter_created(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        voter_id: AccountId,
        refund_amount: U128,
    );
    fn on_registration_complete(&mut self, voter_id: AccountId);
    fn on_buy(
        &mut self,
        token_id: TokenId,
        seller_id: AccountId,
        buyer_id: AccountId,
        price: U128,
    );
}

#[near]
impl SeatNft {
    #[init]
    pub fn new(
        dao: AccountId,
        voter_code_hash: Base58CryptoHash,
        levy_bps: u16,
        window_ns: u64,
    ) -> Self {
        assert!(levy_bps <= 10_000, "ERR_BAD_LEVY");
        assert!(window_ns > 0, "ERR_BAD_WINDOW");
        let owner_id = env::current_account_id();
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Seat".to_string(),
            symbol: "SEAT".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        Self {
            dao,
            voter_code_hash: voter_code_hash.into(),
            levy_bps,
            window_ns,
            next_seat: 1,
            tokens: NonFungibleToken::new(b"o", owner_id, Some(b"m"), Some(b"e"), Some(b"a")),
            metadata: LazyOption::new(b"meta".to_vec(), Some(&metadata)),
            seats: LookupMap::new(b"seat".to_vec()),
        }
    }

    #[payable]
    pub fn mint_seat(&mut self, receiver_id: AccountId) -> Promise {
        self.assert_dao();
        let attached = env::attached_deposit().as_yoctonear();
        assert!(attached >= MIN_VOTER_FUNDING, "ERR_INSUFFICIENT_DEPOSIT");
        let token_id = self.next_seat.to_string();
        self.next_seat += 1;
        let voter_id = self.voter_account_id(&token_id);
        let registration_deposit = env::storage_byte_cost().as_yoctonear() * 16;
        assert!(attached > registration_deposit, "ERR_INSUFFICIENT_DEPOSIT");
        let voter_funding = attached - registration_deposit;
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "dao": self.dao,
            "admin": env::current_account_id(),
            "controller": receiver_id,
            "window_ns": self.window_ns,
        }))
        .expect("ERR_SERIALIZE");

        Promise::new(voter_id.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(voter_funding))
            .use_global_contract(self.voter_code_hash)
            .function_call(
                "new".to_string(),
                args,
                NearToken::from_yoctonear(0),
                VOTER_INIT_GAS,
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(VOTER_CREATED_CALLBACK_GAS)
                    .on_voter_created(token_id, receiver_id, voter_id, U128(attached)),
            )
    }

    #[private]
    pub fn on_voter_created(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        voter_id: AccountId,
        refund_amount: U128,
    ) -> PromiseOrValue<bool> {
        if !matches!(env::promise_result(0), PromiseResult::Successful(_)) {
            return PromiseOrValue::Promise(
                Promise::new(self.dao.clone()).transfer(NearToken::from_yoctonear(refund_amount.0)),
            );
        }

        let token = self.tokens.internal_mint_with_refund(
            token_id.clone(),
            receiver_id,
            Some(TokenMetadata {
                title: Some(format!("Seat {token_id}")),
                description: Some("A DAO-governed membership seat".to_string()),
                media: None,
                media_hash: None,
                copies: Some(1),
                issued_at: None,
                expires_at: None,
                starts_at: None,
                updated_at: None,
                extra: None,
                reference: None,
                reference_hash: None,
            }),
            None,
        );
        NftMint {
            owner_id: &token.owner_id,
            token_ids: &[&token.token_id],
            memo: None,
        }
        .emit();
        self.seats.insert(
            token_id,
            SeatRecord {
                voter_id: voter_id.clone(),
                approval: None,
            },
        );
        let registration_deposit = env::storage_byte_cost().as_yoctonear() * 16;
        PromiseOrValue::Promise(
            ext_dao::ext(self.dao.clone())
                .with_attached_deposit(NearToken::from_yoctonear(registration_deposit))
                .with_static_gas(DAO_CALL_GAS)
                .register_delegation(voter_id.clone())
                .then(
                    ext_self::ext(env::current_account_id())
                        .with_static_gas(REGISTRATION_CALLBACK_GAS)
                        .on_registration_complete(voter_id),
                ),
        )
    }

    #[private]
    pub fn on_registration_complete(&mut self, voter_id: AccountId) -> PromiseOrValue<bool> {
        if !matches!(env::promise_result(0), PromiseResult::Successful(_)) {
            return PromiseOrValue::Value(false);
        }
        PromiseOrValue::Promise(
            ext_dao::ext(self.dao.clone())
                .with_static_gas(DAO_CALL_GAS)
                .delegate(voter_id, U128(1)),
        )
    }

    pub fn approve_sale(
        &mut self,
        token_id: TokenId,
        buyer: AccountId,
        price: U128,
        expires_in_ns: u64,
    ) {
        self.assert_dao();
        assert!(!Self::buy_in_progress(&token_id), "ERR_BUY_IN_PROGRESS");
        let mut record = self.seats.get(&token_id).cloned().expect("ERR_NO_TOKEN");
        assert!(price.0 > 0, "ERR_BAD_PRICE");
        assert!(
            Self::sale_split(price.0, self.levy_bps).is_some(),
            "ERR_PRICE_OVERFLOW"
        );
        assert!(expires_in_ns > 0, "ERR_BAD_EXPIRY");
        assert_ne!(
            buyer,
            self.tokens.owner_by_id.get(&token_id).expect("ERR_NO_TOKEN"),
            "ERR_SAME_BUYER"
        );
        record.approval = Some(SaleApproval {
            buyer,
            price,
            expires_at: env::block_timestamp().saturating_add(expires_in_ns),
        });
        self.seats.insert(token_id, record);
    }

    #[payable]
    pub fn buy(&mut self, token_id: TokenId) -> Promise {
        let record = self.seats.get(&token_id).cloned().expect("ERR_NO_TOKEN");
        let approval = record.approval.expect("ERR_NO_APPROVAL");
        let buyer = env::predecessor_account_id();
        assert_eq!(buyer, approval.buyer, "ERR_WRONG_BUYER");
        assert!(env::block_timestamp() < approval.expires_at, "ERR_APPROVAL_EXPIRED");
        assert!(!Self::buy_in_progress(&token_id), "ERR_BUY_IN_PROGRESS");
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            approval.price.0,
            "ERR_WRONG_DEPOSIT"
        );
        let seller = self.tokens.owner_by_id.get(&token_id).expect("ERR_NO_TOKEN");
        Self::set_buy_in_progress(&token_id, true);
        ext_voter::ext(record.voter_id)
            .with_static_gas(VOTER_CALL_GAS)
            .set_controller(buyer.clone())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(BUY_CALLBACK_GAS)
                    .on_buy(token_id, seller, buyer, approval.price),
            )
    }

    #[private]
    pub fn on_buy(
        &mut self,
        token_id: TokenId,
        seller_id: AccountId,
        buyer_id: AccountId,
        price: U128,
    ) {
        if !matches!(env::promise_result(0), PromiseResult::Successful(_)) {
            Self::set_buy_in_progress(&token_id, false);
            Promise::new(buyer_id)
                .transfer(NearToken::from_yoctonear(price.0))
                .detach();
            return;
        }

        let record = self.seats.get(&token_id).cloned().expect("ERR_NO_TOKEN");
        self.tokens.internal_transfer(
            &seller_id,
            &buyer_id,
            &token_id,
            None,
            Some("approved resale".to_string()),
        );
        let mut record = record;
        record.approval = None;
        self.seats.insert(token_id.clone(), record);
        Self::set_buy_in_progress(&token_id, false);

        let (seller_amount, levy) =
            Self::sale_split(price.0, self.levy_bps).expect("ERR_PRICE_OVERFLOW");
        Promise::new(seller_id)
            .transfer(NearToken::from_yoctonear(seller_amount))
            .detach();
        Promise::new(self.dao.clone())
            .transfer(NearToken::from_yoctonear(levy))
            .detach();
    }

    fn buy_in_progress(token_id: &str) -> bool {
        env::storage_read(&Self::buy_lock_key(token_id)).is_some()
    }

    fn set_buy_in_progress(token_id: &str, in_progress: bool) {
        let key = Self::buy_lock_key(token_id);
        if in_progress {
            env::storage_write(&key, &[1]);
        } else {
            env::storage_remove(&key);
        }
    }

    fn buy_lock_key(token_id: &str) -> Vec<u8> {
        let mut key = b"seat_nft_buy_lock:".to_vec();
        key.extend_from_slice(token_id.as_bytes());
        key
    }

    fn sale_split(price: u128, levy_bps: u16) -> Option<(u128, u128)> {
        let levy = price.checked_mul(levy_bps as u128)? / 10_000;
        Some((price.checked_sub(levy)?, levy))
    }

    pub fn get_seat(&self, token_id: TokenId) -> Option<SeatView> {
        self.seats.get(&token_id).map(|record| SeatView {
            voter_id: record.voter_id.clone(),
            approval: record.approval.clone(),
        })
    }

    pub fn get_storage_usage(&self) -> u64 {
        env::storage_usage()
    }

    #[cfg(feature = "sandbox-test")]
    #[payable]
    pub fn mint_test_seat(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        voter_id: AccountId,
    ) {
        self.assert_dao();
        self.mint_test_seat_inner(token_id, receiver_id, voter_id);
    }

    #[cfg(any(test, feature = "sandbox-test"))]
    fn mint_test_seat_inner(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        voter_id: AccountId,
    ) {
        assert!(self.tokens.owner_by_id.get(&token_id).is_none(), "ERR_TOKEN_EXISTS");
        let token = self.tokens.internal_mint_with_refund(
            token_id.clone(),
            receiver_id,
            Some(TokenMetadata {
                title: Some(format!("Test seat {token_id}")),
                description: Some("Test fixture with an externally administered voter".to_string()),
                media: None,
                media_hash: None,
                copies: Some(1),
                issued_at: None,
                expires_at: None,
                starts_at: None,
                updated_at: None,
                extra: None,
                reference: None,
                reference_hash: None,
            }),
            None,
        );
        NftMint {
            owner_id: &token.owner_id,
            token_ids: &[&token.token_id],
            memo: None,
        }
        .emit();
        self.seats.insert(
            token_id,
            SeatRecord {
                voter_id,
                approval: None,
            },
        );
    }

    fn assert_dao(&self) {
        assert_eq!(env::predecessor_account_id(), self.dao, "ERR_NOT_DAO");
    }

    fn voter_account_id(&self, token_id: &str) -> AccountId {
        format!("s{token_id}.{}", env::current_account_id())
            .parse()
            .expect("ERR_BAD_VOTER_ACCOUNT_ID")
    }
}

#[near]
impl NonFungibleTokenCore for SeatNft {
    #[payable]
    fn nft_transfer(
        &mut self,
        _receiver_id: AccountId,
        _token_id: TokenId,
        _approval_id: Option<u64>,
        _memo: Option<String>,
    ) {
        env::panic_str("ERR_APPROVAL_REQUIRED");
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        _receiver_id: AccountId,
        _token_id: TokenId,
        _approval_id: Option<u64>,
        _memo: Option<String>,
        _msg: String,
    ) -> PromiseOrValue<bool> {
        env::panic_str("ERR_APPROVAL_REQUIRED");
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        NonFungibleTokenCore::nft_token(&self.tokens, token_id)
    }
}

#[near]
impl NonFungibleTokenEnumeration for SeatNft {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(
        &self,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for SeatNft {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().expect("ERR_NO_METADATA")
    }
}

#[near]
impl NonFungibleTokenApproval for SeatNft {
    #[payable]
    fn nft_approve(
        &mut self,
        _token_id: TokenId,
        _account_id: AccountId,
        _msg: Option<String>,
    ) -> Option<Promise> {
        env::panic_str("ERR_APPROVAL_REQUIRED");
    }

    #[payable]
    fn nft_revoke(&mut self, _token_id: TokenId, _account_id: AccountId) {
        env::panic_str("ERR_APPROVAL_REQUIRED");
    }

    #[payable]
    fn nft_revoke_all(&mut self, _token_id: TokenId) {
        env::panic_str("ERR_APPROVAL_REQUIRED");
    }

    fn nft_is_approved(
        &self,
        _token_id: TokenId,
        _approved_account_id: AccountId,
        _approval_id: Option<u64>,
    ) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const SEAT: &str = "seat.testnet";
    const DAO: &str = "dao.testnet";
    const SELLER: &str = "seller.testnet";
    const BUYER: &str = "buyer.testnet";
    const OTHER: &str = "other.testnet";
    const VOTER: &str = "voter.testnet";

    fn account_id(value: &str) -> AccountId {
        value.parse().unwrap()
    }

    fn set_context(predecessor: &str, timestamp: u64, deposit: u128) {
        let context = VMContextBuilder::new()
            .current_account_id(account_id(SEAT))
            .predecessor_account_id(account_id(predecessor))
            .block_timestamp(timestamp)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build();
        testing_env!(context);
    }

    fn contract_with_seat() -> SeatNft {
        set_context(DAO, 1_000, 0);
        let mut contract = SeatNft::new(
            account_id(DAO),
            Base58CryptoHash::from([1; 32]),
            500,
            60,
        );
        set_context(DAO, 1_000, 1_000_000_000_000_000_000_000_000);
        contract.mint_test_seat_inner(
            "1".to_string(),
            account_id(SELLER),
            account_id(VOTER),
        );
        contract
    }

    fn approve_sale(contract: &mut SeatNft, buyer: &str, price: u128, expires_in_ns: u64) {
        set_context(DAO, 1_000, 0);
        contract.approve_sale(
            "1".to_string(),
            account_id(buyer),
            U128(price),
            expires_in_ns,
        );
    }

    #[test]
    #[should_panic(expected = "ERR_APPROVAL_REQUIRED")]
    fn nft_transfer_requires_sale_approval() {
        let mut contract = contract_with_seat();
        contract.nft_transfer(account_id(BUYER), "1".to_string(), None, None);
    }

    #[test]
    #[should_panic(expected = "ERR_APPROVAL_REQUIRED")]
    fn nft_transfer_call_requires_sale_approval() {
        let mut contract = contract_with_seat();
        contract.nft_transfer_call(
            account_id(BUYER),
            "1".to_string(),
            None,
            None,
            "transfer".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "ERR_APPROVAL_REQUIRED")]
    fn nft_approve_requires_sale_approval() {
        let mut contract = contract_with_seat();
        contract.nft_approve("1".to_string(), account_id(BUYER), None);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_DAO")]
    fn approve_sale_is_dao_only() {
        let mut contract = contract_with_seat();
        set_context(OTHER, 1_000, 0);
        contract.approve_sale("1".to_string(), account_id(BUYER), U128(100), 10);
    }

    #[test]
    #[should_panic(expected = "ERR_NO_APPROVAL")]
    fn buy_requires_approval() {
        let mut contract = contract_with_seat();
        set_context(BUYER, 1_001, 100);
        contract.buy("1".to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_WRONG_BUYER")]
    fn buy_rejects_wrong_buyer() {
        let mut contract = contract_with_seat();
        approve_sale(&mut contract, BUYER, 100, 10);
        set_context(OTHER, 1_001, 100);
        contract.buy("1".to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_WRONG_DEPOSIT")]
    fn buy_rejects_wrong_deposit() {
        let mut contract = contract_with_seat();
        approve_sale(&mut contract, BUYER, 100, 10);
        set_context(BUYER, 1_001, 99);
        contract.buy("1".to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_APPROVAL_EXPIRED")]
    fn buy_rejects_expired_approval() {
        let mut contract = contract_with_seat();
        approve_sale(&mut contract, BUYER, 100, 10);
        set_context(BUYER, 1_010, 100);
        contract.buy("1".to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_BUY_IN_PROGRESS")]
    fn buy_rejects_concurrent_sale_while_locked() {
        let mut contract = contract_with_seat();
        approve_sale(&mut contract, BUYER, 100, 10);
        set_context(BUYER, 1_001, 100);
        SeatNft::set_buy_in_progress("1", true);
        contract.buy("1".to_string());
    }

    #[test]
    fn levy_split_is_ninety_five_five_and_rounds_down() {
        let contract = contract_with_seat();
        assert_eq!(SeatNft::sale_split(10_000, 500), Some((9_500, 500)));
        assert_eq!(SeatNft::sale_split(101, 500), Some((96, 5)));
        assert_eq!(SeatNft::sale_split(1, 500), Some((1, 0)));
        drop(contract);
    }

    #[test]
    fn levy_split_detects_overflow() {
        assert_eq!(SeatNft::sale_split(u128::MAX, 500), None);
    }

    #[test]
    #[should_panic(expected = "ERR_PRICE_OVERFLOW")]
    fn approve_sale_rejects_price_times_levy_overflow() {
        let mut contract = contract_with_seat();
        set_context(DAO, 1_000, 0);
        contract.approve_sale(
            "1".to_string(),
            account_id(BUYER),
            U128(u128::MAX),
            10,
        );
    }
}

pub fn actor_state(team_id: &str, actor_id: &str) -> String {
    teamclu_types::mqtt::actor_state(team_id, actor_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actor_state_format() {
        assert_eq!(actor_state("t1", "d1"), "amux/t1/d1/state");
    }
}

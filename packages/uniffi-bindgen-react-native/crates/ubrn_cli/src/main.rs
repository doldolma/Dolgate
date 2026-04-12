/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/
 */
use clap::Parser;
use ubrn_cli::{cli, Result};

fn main() -> Result<()> {
    let args = cli::CliArgs::parse();
    args.run()
}

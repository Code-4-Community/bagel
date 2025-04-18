Repo for C4C's premier team-bonding application Bagel.

- bagelbot: slack bot to add facts about yourself for conversation matching
- conversation_matcher: periodic conversation matcher that brings two random people together to chat

To deploy:
1. Zip your application code (either `bagelbot` or `conversation_matcher`) with their respective `zipthis.sh` script
2. Upload the .zip to AWS Lambda
3. Profit
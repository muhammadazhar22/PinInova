-- Erasure needs the app role to anonymise its own audit rows and delete organisations it owns.
CREATE POLICY audit_anonymise ON audit_event FOR UPDATE USING (true) WITH CHECK (actor = 'erased-user');

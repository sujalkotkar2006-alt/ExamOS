"""Generate isolated test-only trust and expired certificates, never install system trust."""
import datetime
import ipaddress
import sys
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=False)
now=datetime.datetime.now(datetime.timezone.utc)
key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Isolated ExamOS Test CA')])
ca=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
    .serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(days=2))
    .not_valid_after(now+datetime.timedelta(days=2)).add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True)
    .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()),critical=False)
    .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()),critical=False)
    .add_extension(x509.KeyUsage(False,False,False,False,False,True,True,False,False),critical=True)
    .sign(key,hashes.SHA256()))
(out/'ca.crt').write_bytes(ca.public_bytes(serialization.Encoding.PEM))
for filename,expiry in [('server',now+datetime.timedelta(days=1)),('expired',now-datetime.timedelta(days=1))]:
    server_key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    cert=(x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')]))
          .issuer_name(name).public_key(server_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now-datetime.timedelta(days=2)).not_valid_after(expiry)
          .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False)
          .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()),critical=False)
          .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),critical=False)
          .add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True)
          .sign(key,hashes.SHA256()))
    (out/(filename+'.crt')).write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (out/(filename+'.key')).write_bytes(server_key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
